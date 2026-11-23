#define _GNU_SOURCE
#include <asm/unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <sched.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

#if defined(__x86_64__) && !defined(__ILP32__)
#define NATIVE_ARCH AUDIT_ARCH_X86_64
#define ELF_LOADER "/lib64/ld-linux-x86-64.so.2"
#define MUSL_LOADER "/lib/ld-musl-x86_64.so.1"
#elif defined(__aarch64__) && __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
#define NATIVE_ARCH AUDIT_ARCH_AARCH64
#define ELF_LOADER "/lib/ld-linux-aarch64.so.1"
#define MUSL_LOADER "/lib/ld-musl-aarch64.so.1"
#else
#error Unsupported Linux sandbox architecture
#endif

#define READ_FILE LANDLOCK_ACCESS_FS_READ_FILE
#define READ_TREE (READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR)
#define EXEC LANDLOCK_ACCESS_FS_EXECUTE

static void fail(const char *message) {
    perror(message);
    exit(1);
}

static void allow_path(int rules, const char *path, uint64_t access, int optional) {
    int fd = open(path, O_PATH | O_CLOEXEC);
    if (fd < 0) {
        if (optional && errno == ENOENT) return;
        fail(path);
    }
    struct landlock_path_beneath_attr rule = { .allowed_access = access, .parent_fd = fd };
    if (syscall(__NR_landlock_add_rule, rules, LANDLOCK_RULE_PATH_BENEATH, &rule, 0) < 0) fail(path);
    close(fd);
}

static void restrict_files(const char *stage, const char *node) {
    // Landlock ABI 1 handles these thirteen rights. Seccomp also denies
    // truncate and path mutation, including on kernels with Landlock ABI 1.
    const struct landlock_ruleset_attr policy = { .handled_access_fs = (1ULL << 13) - 1 };
    int rules = syscall(__NR_landlock_create_ruleset, &policy, sizeof(policy.handled_access_fs), 0);
    if (rules < 0) fail("IFC MCP requires Linux Landlock (kernel 5.13+ with Landlock enabled)");
    allow_path(rules, stage, READ_TREE, 0);
    allow_path(rules, node, EXEC, 0);
    const char *libraries[] = { "/lib", "/lib64", "/usr/lib", "/usr/lib64" };
    for (size_t i = 0; i < sizeof(libraries) / sizeof(*libraries); i++)
        allow_path(rules, libraries[i], READ_TREE, 1);
    allow_path(rules, ELF_LOADER, READ_FILE | EXEC, 1);
    allow_path(rules, MUSL_LOADER, READ_FILE | EXEC, 1);
    allow_path(rules, "/etc/ld.so.cache", READ_FILE, 1);
    allow_path(rules, "/dev/null", READ_FILE, 1);
    allow_path(rules, "/dev/urandom", READ_FILE, 1);
    if (syscall(__NR_landlock_restrict_self, rules, 0) < 0) fail("Could not enforce IFC MCP filesystem restrictions");
    close(rules);
}

#define RETURN(value) BPF_STMT(BPF_RET | BPF_K, (value))
#define DENY RETURN(SECCOMP_RET_ERRNO | EPERM)
#define ALLOW(call) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_##call, 0, 1), RETURN(SECCOMP_RET_ALLOW)
// The supported ABIs are little-endian and the filtered parameters are 32-bit.
#define ALLOW_MASKED(call, arg, mask, value) \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_##call, 0, 5), \
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[arg])), \
    BPF_STMT(BPF_ALU | BPF_AND | BPF_K, (mask)), \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (value), 1, 0), DENY, RETURN(SECCOMP_RET_ALLOW)

static void restrict_syscalls(void) {
    const uint32_t write_open = O_ACCMODE | O_CREAT | O_TRUNC | (O_TMPFILE & ~O_DIRECTORY);
    const uint32_t thread_flags = CLONE_THREAD | CLONE_VM | CLONE_FS | CLONE_FILES | CLONE_SIGHAND |
        CLONE_SYSVSEM | CLONE_SETTLS | CLONE_PARENT_SETTID | CLONE_CHILD_CLEARTID | CLONE_CHILD_SETTID;
    // Anything absent, including socket creation, filesystem mutations, IPC,
    // ptrace, io_uring and subprocess creation, stays denied.
    struct sock_filter rules[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, NATIVE_ARCH, 1, 0), RETURN(SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        ALLOW_MASKED(openat, 2, write_open, O_RDONLY),
#ifdef __NR_open
        ALLOW_MASKED(open, 1, write_open, O_RDONLY),
#endif
        ALLOW_MASKED(clone, 0, ~thread_flags | CLONE_THREAD, CLONE_THREAD),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone3, 0, 1), RETURN(SECCOMP_RET_ERRNO | ENOSYS),
        ALLOW_MASKED(tgkill, 0, UINT32_MAX, (uint32_t)getpid()),
        ALLOW_MASKED(prlimit64, 0, UINT32_MAX, 0),
        ALLOW_MASKED(prctl, 0, UINT32_MAX, PR_SET_NAME),
        ALLOW(read), ALLOW(write), ALLOW(readv), ALLOW(writev), ALLOW(pread64), ALLOW(preadv),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_fcntl, 0, 9),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, F_GETFD, 6, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, F_SETFD, 5, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, F_GETFL, 4, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, F_SETFL, 3, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, F_DUPFD, 2, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, F_DUPFD_CLOEXEC, 1, 0),
        DENY, RETURN(SECCOMP_RET_ALLOW),
        ALLOW(close), ALLOW(dup), ALLOW(dup3), ALLOW(lseek), ALLOW(getdents64),
        ALLOW(fstat), ALLOW(newfstatat), ALLOW(statx), ALLOW(readlinkat), ALLOW(faccessat), ALLOW(faccessat2),
#ifdef __NR_stat
        ALLOW(stat), ALLOW(lstat), ALLOW(readlink), ALLOW(access), ALLOW(dup2), ALLOW(pipe), ALLOW(poll),
#endif
        ALLOW(mmap), ALLOW(munmap), ALLOW(mprotect), ALLOW(mremap), ALLOW(madvise), ALLOW(brk),
#ifdef __NR_arch_prctl
        ALLOW(arch_prctl),
#endif
        ALLOW(getrandom), ALLOW(uname), ALLOW(sysinfo), ALLOW(getpid), ALLOW(getppid), ALLOW(gettid),
        ALLOW(getuid), ALLOW(geteuid), ALLOW(getgid), ALLOW(getegid), ALLOW(getcwd), ALLOW(getrusage),
        ALLOW(clock_gettime), ALLOW(clock_getres), ALLOW(clock_nanosleep), ALLOW(nanosleep),
        ALLOW(rt_sigaction), ALLOW(rt_sigprocmask), ALLOW(rt_sigreturn), ALLOW(sigaltstack),
        ALLOW(futex), ALLOW(set_tid_address), ALLOW(set_robust_list), ALLOW(rseq), ALLOW(membarrier),
        ALLOW(sched_yield), ALLOW(sched_getaffinity), ALLOW(getcpu), ALLOW(restart_syscall),
        ALLOW(epoll_create1), ALLOW(epoll_ctl), ALLOW(epoll_pwait), ALLOW(epoll_pwait2),
#ifdef __NR_epoll_wait
        ALLOW(epoll_wait),
#endif
        ALLOW(eventfd2), ALLOW(pipe2), ALLOW(ppoll), ALLOW(pselect6),
        // libuv operates on the inherited stdio socketpairs.
        ALLOW(getsockname), ALLOW_MASKED(getsockopt, 1, UINT32_MAX, SOL_SOCKET), ALLOW(shutdown),
        ALLOW_MASKED(ioctl, 1, UINT32_MAX, FIONBIO),
        ALLOW(execve), ALLOW(exit), ALLOW(exit_group), DENY,
    };
    const struct sock_fprog filter = { .len = sizeof(rules) / sizeof(*rules), .filter = rules };
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &filter) < 0) fail("Could not enforce IFC MCP syscall restrictions");
}

int main(int argc, char **argv) {
    char *end;
    long parent = argc == 3 ? strtol(argv[2], &end, 10) : 0;
    if (parent < 1 || parent > INT_MAX || *end || argv[1][0] != '/') {
        fputs("Expected an absolute IFC MCP runtime directory and parent process ID.\n", stderr);
        return 1;
    }
    char node[PATH_MAX];
    if (snprintf(node, sizeof(node), "%s/node", argv[1]) >= (int)sizeof(node)) {
        fputs("IFC MCP runtime path is too long.\n", stderr);
        return 1;
    }
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) < 0) fail("Could not bind the sandbox lifetime to IFC MCP");
    if (parent != getppid()) return 1;
    const struct rlimit core_limit = { 0, 0 };
    if (setrlimit(RLIMIT_CORE, &core_limit) < 0) fail("Could not disable IFC MCP sandbox core dumps");
    if (syscall(__NR_close_range, 3U, UINT32_MAX, 0) < 0) fail("Could not close inherited IFC MCP descriptors");
    if (chdir(argv[1]) < 0) fail("Could not enter the IFC MCP runtime directory");
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) fail("Could not set IFC MCP no-new-privileges");
    restrict_files(argv[1], node);
    restrict_syscalls();
    char *const args[] = { node, "--openssl-config=/dev/null", "python-worker-node.mjs", NULL };
    char *const env[] = { NULL };
    execve(node, args, env);
    fail("Could not start IFC MCP Python in the Linux sandbox");
}
