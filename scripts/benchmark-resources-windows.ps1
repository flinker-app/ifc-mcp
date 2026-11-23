param([uint32]$RootProcess, [int]$LogicalCpus)

$ErrorActionPreference = 'Stop'
$clock = [Diagnostics.Stopwatch]::StartNew()
$previousTime = $null
$previousCpu = @{}
$previousEngines = @{}
$previousGpuTime = $null

while ($true) {
    $processes = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate, WorkingSetSize, PrivatePageCount, UserModeTime, KernelModeTime)
    if ($RootProcess -notin $processes.ProcessId) { break }
    $time = $clock.Elapsed.TotalMilliseconds
    $queue = [System.Collections.Generic.Queue[uint32]]::new()
    $tree = [System.Collections.Generic.HashSet[uint32]]::new()
    $queue.Enqueue($RootProcess)
    while ($queue.Count) {
        $id = $queue.Dequeue()
        if (!$tree.Add($id)) { continue }
        foreach ($entry in $processes) {
            if ($entry.ParentProcessId -eq $id -and $entry.ProcessId -ne $PID) {
                $queue.Enqueue($entry.ProcessId)
            }
        }
    }
    [void]$tree.Remove($RootProcess)
    $currentCpu = @{}
    $rss = 0L
    $private = 0L
    $cpuTicks = 0L
    foreach ($entry in $processes) {
        if (!$tree.Contains($entry.ProcessId)) { continue }
        $rss += $entry.WorkingSetSize
        $private += $entry.PrivatePageCount
        $key = "$($entry.ProcessId):$($entry.CreationDate.Ticks)"
        $usage = [long]$entry.UserModeTime + [long]$entry.KernelModeTime
        $currentCpu[$key] = $usage
        $cpuTicks += [Math]::Max(0L, $usage - [long]$previousCpu[$key])
    }
    $cpu = if ($null -ne $previousTime) { 100 * $cpuTicks / (10000 * ($time - $previousTime) * $LogicalCpus) }
    $previousTime = $time
    $previousCpu = $currentCpu

    $gpu = $null
    $dedicated = $null
    $shared = $null
    try {
        $engines = @(Get-CimInstance Win32_PerfRawData_GPUPerformanceCounters_GPUEngine -Property Name, RunningTime, Timestamp_Sys100NS)
        $gpuTime = if ($engines.Count) { [long]$engines[0].Timestamp_Sys100NS } else { [DateTime]::UtcNow.ToFileTimeUtc() }
        $currentEngines = @{}
        $engineDeltas = @{}
        foreach ($engine in $engines) {
            if ($engine.Name -notmatch '^pid_(\d+)_(.+)$' -or !$tree.Contains([uint32]$Matches[1])) { continue }
            $key = $Matches[2]
            $usage = [long]$engine.RunningTime
            $currentEngines[$engine.Name] = $usage
            $engineDeltas[$key] = $engineDeltas[$key] + [Math]::Max(0L, $usage - [long]$previousEngines[$engine.Name])
        }
        if ($null -ne $previousGpuTime -and $gpuTime -gt $previousGpuTime) {
            $peakTicks = ($engineDeltas.Values | Measure-Object -Maximum).Maximum
            $gpu = [Math]::Min(100, 100 * [double]$peakTicks / ($gpuTime - $previousGpuTime))
        }
        $previousEngines = $currentEngines
        $previousGpuTime = $gpuTime

        $memory = @(Get-CimInstance Win32_PerfRawData_GPUPerformanceCounters_GPUProcessMemory -Property Name, DedicatedUsage, SharedUsage)
        $dedicated = 0L
        $shared = 0L
        foreach ($entry in $memory) {
            if ($entry.Name -notmatch '^pid_(\d+)_' -or !$tree.Contains([uint32]$Matches[1])) { continue }
            $dedicated += $entry.DedicatedUsage
            $shared += $entry.SharedUsage
        }
    } catch [Microsoft.Management.Infrastructure.CimException] {
        # GPU counters can be absent, particularly on headless Windows hosts.
    }
    [Console]::WriteLine((@{
        time_ms = $time
        rss_bytes = $rss
        private_bytes = $private
        cpu_percent = $cpu
        gpu_percent = $gpu
        gpu_dedicated_bytes = $dedicated
        gpu_shared_bytes = $shared
    } | ConvertTo-Json -Compress))
    Start-Sleep -Milliseconds 100
}
