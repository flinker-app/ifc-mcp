using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

internal static class WindowsPythonSandbox
{
    private const int SecurityCapabilities = 0x00020009;
    private const int HandleList = 0x00020002;
    private const int AllApplicationPackagesPolicy = 0x0002000f;
    private const int JobList = 0x0002000d;
    private const int CreateExtendedStartup = 0x00080000;
    private const int CreateNoWindow = 0x08000000;
    private const int CreateUnicodeEnvironment = 0x00000400;
    private const uint JobKillOnClose = 0x00002000;
    private const uint JobActiveProcess = 0x00000008;

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 2 && args[0] == "clean")
            {
                DeleteAppContainerProfile(ProfileName(args[1]));
                return 0;
            }
            if (args.Length != 2) throw new ArgumentException("Expected runtime directory and sandbox ID.");
            return Run(Path.GetFullPath(args[0]), ProfileName(args[1]));
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Windows Python sandbox: " + error);
            return 1;
        }
    }

    private static string ProfileName(string id)
    {
        Guid guid;
        if (!Guid.TryParseExact(id, "D", out guid)) throw new ArgumentException("Invalid sandbox ID.");
        return "IfcMcpPython." + guid.ToString("N");
    }

    private static int Run(string directory, string profile)
    {
        IntPtr sid;
        Marshal.ThrowExceptionForHR(CreateAppContainerProfile(profile, "IFC MCP Python", "Isolated IFC runtime", IntPtr.Zero, 0, out sid));
        var handles = new IntPtr[3];
        try
        {
            GrantRuntimeAccess(directory, new SecurityIdentifier(sid));
            for (int index = 0; index < handles.Length; index++) handles[index] = CopyStandardHandle(-10 - index);
            var job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception();
            try
            {
                var limits = new ExtendedJobLimits();
                limits.Basic.Flags = JobKillOnClose | JobActiveProcess;
                limits.Basic.ActiveProcessLimit = 1;
                Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits)));
                return Launch(directory, sid, handles, job);
            }
            finally { CloseHandle(job); }
        }
        finally
        {
            foreach (var handle in handles) if (handle != IntPtr.Zero) CloseHandle(handle);
            FreeSid(sid);
            DeleteAppContainerProfile(profile);
        }
    }

    private static void GrantRuntimeAccess(string path, SecurityIdentifier sid)
    {
        // The directory is freshly staged by the trusted parent. Protect it from
        // inherited package ACLs and grant only this sandbox identity read/execute.
        var info = new DirectoryInfo(path);
        var acl = info.GetAccessControl(AccessControlSections.Access);
        acl.SetAccessRuleProtection(true, false);
        acl.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User,
            FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None, AccessControlType.Allow));
        acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.ReadAndExecute,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None, AccessControlType.Allow));
        info.SetAccessControl(acl);
    }

    private static IntPtr CopyStandardHandle(int id)
    {
        var original = GetStdHandle(id);
        if (GetFileType(original) != 3) throw new InvalidOperationException("Sandbox I/O must use pipes.");
        var process = GetCurrentProcess();
        IntPtr duplicate;
        Check(DuplicateHandle(process, original, process, out duplicate, 0, true, 2));
        return duplicate;
    }

    private static int Launch(string directory, IntPtr sid, IntPtr[] handles, IntPtr job)
    {
        // Node initializes Winsock even when it does not make a connection.
        // Registry read access lets it initialize its system catalog. The token
        // has no internet, private-network, or server capabilities.
        IntPtr groupSids, capabilitySids;
        uint groupCount, capabilityCount;
        Check(DeriveCapabilitySidsFromName("registryRead", out groupSids, out groupCount, out capabilitySids, out capabilityCount));
        var bytes = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 4, 0, ref bytes);
        var attributes = Marshal.AllocHGlobal(bytes);
        var capabilities = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(ContainerCapabilities)));
        var inheritance = Marshal.AllocHGlobal(handles.Length * IntPtr.Size);
        var jobList = Marshal.AllocHGlobal(IntPtr.Size);
        var optOut = Marshal.AllocHGlobal(sizeof(int));
        var registryRead = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SidAndAttributes)));
        try
        {
            Check(InitializeProcThreadAttributeList(attributes, 4, 0, ref bytes));
            try
            {
                if (capabilityCount != 1) throw new InvalidOperationException("Windows did not return the registry-read capability.");
                Marshal.StructureToPtr(new SidAndAttributes { Sid = Marshal.ReadIntPtr(capabilitySids), Attributes = 4 }, registryRead, false);
                Marshal.StructureToPtr(new ContainerCapabilities { Sid = sid, Capabilities = registryRead, Count = 1 }, capabilities, false);
                Marshal.Copy(handles, 0, inheritance, handles.Length);
                Marshal.WriteIntPtr(jobList, job);
                Marshal.WriteInt32(optOut, 1);
                Attribute(attributes, SecurityCapabilities, capabilities, Marshal.SizeOf(typeof(ContainerCapabilities)));
                Attribute(attributes, HandleList, inheritance, handles.Length * IntPtr.Size);
                Attribute(attributes, JobList, jobList, IntPtr.Size);
                Attribute(attributes, AllApplicationPackagesPolicy, optOut, sizeof(int));

                var startup = new ExtendedStartupInfo();
                startup.Startup.Size = Marshal.SizeOf(startup);
                startup.Startup.Flags = 0x100;
                startup.Startup.Input = handles[0];
                startup.Startup.Output = handles[1];
                startup.Startup.Error = handles[2];
                startup.Attributes = attributes;
                string executable = Path.Combine(directory, "node.exe");
                var command = new StringBuilder("\"" + executable + "\" --preserve-symlinks-main --preserve-symlinks python-worker-node.mjs");
                string systemRoot = Directory.GetParent(Environment.SystemDirectory).FullName;
                var environment = Marshal.StringToHGlobalUni(
                    "LOCALAPPDATA=" + Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) + "\0" +
                    "SystemRoot=" + systemRoot + "\0" +
                    "USERPROFILE=" + Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) + "\0\0");
                ProcessInformation process;
                try
                {
                    Check(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true,
                        CreateExtendedStartup | CreateNoWindow | CreateUnicodeEnvironment,
                        environment, directory, ref startup, out process));
                }
                finally { Marshal.FreeHGlobal(environment); }
                CloseHandle(process.Thread);
                try
                {
                    if (WaitForSingleObject(process.Process, uint.MaxValue) != 0) throw new Win32Exception();
                    int code;
                    Check(GetExitCodeProcess(process.Process, out code));
                    return code;
                }
                finally { CloseHandle(process.Process); }
            }
            finally { DeleteProcThreadAttributeList(attributes); }
        }
        finally
        {
            Marshal.FreeHGlobal(attributes);
            Marshal.FreeHGlobal(capabilities);
            Marshal.FreeHGlobal(inheritance);
            Marshal.FreeHGlobal(jobList);
            Marshal.FreeHGlobal(optOut);
            Marshal.FreeHGlobal(registryRead);
            FreeCapabilitySids(groupSids, groupCount);
            FreeCapabilitySids(capabilitySids, capabilityCount);
        }
    }

    private static void FreeCapabilitySids(IntPtr values, uint count)
    {
        if (values == IntPtr.Zero) return;
        for (int index = 0; index < count; index++) LocalFree(Marshal.ReadIntPtr(values, index * IntPtr.Size));
        LocalFree(values);
    }

    private static void Attribute(IntPtr list, int key, IntPtr value, int size)
    {
        Check(UpdateProcThreadAttribute(list, 0, new IntPtr(key), value, new IntPtr(size), IntPtr.Zero, IntPtr.Zero));
    }

    private static void Check(bool result)
    {
        if (!result) throw new Win32Exception();
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ContainerCapabilities { public IntPtr Sid, Capabilities; public uint Count, Reserved; }

    [StructLayout(LayoutKind.Sequential)]
    private struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        public int Size;
        public IntPtr Reserved, Desktop, Title;
        public int X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public short ShowWindow, ReservedSize;
        public IntPtr ReservedData, Input, Output, Error;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedStartupInfo { public StartupInfo Startup; public IntPtr Attributes; }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation { public IntPtr Process, Thread; public int ProcessId, ThreadId; }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicJobLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedJobLimits
    {
        public BasicJobLimits Basic;
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int CreateAppContainerProfile(string name, string displayName, string description,
        IntPtr capabilities, uint count, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int DeleteAppContainerProfile(string name);
    [DllImport("advapi32.dll")] private static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("kernelbase.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool DeriveCapabilitySidsFromName(string name, out IntPtr groups, out uint groupCount,
        out IntPtr capabilities, out uint capabilityCount);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll")] private static extern uint GetFileType(IntPtr file);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(IntPtr source, IntPtr handle, IntPtr target, out IntPtr duplicate,
        uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr list, int flags, IntPtr attribute, IntPtr value,
        IntPtr size, IntPtr previous, IntPtr returnSize);
    [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedJobLimits info, int bytes);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, int flags, IntPtr environment, string directory,
        ref ExtendedStartupInfo startup, out ProcessInformation process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out int code);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
}
