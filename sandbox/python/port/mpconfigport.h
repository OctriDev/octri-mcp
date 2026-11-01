// MicroPython configuration for the code mode sandbox.
//
// Start from the extra-features level so scripts get a familiar Python
// (f-strings, json, re, collections), then turn off everything that reaches
// outside the interpreter: no filesystem, no imports from files, no OS, no
// stdin, no clocks, no raw memory access, no loading of precompiled bytecode.
// The JavaScript bridge modules (`js`, `jsffi`) of the upstream webassembly
// port are not built at all: the only way out is `_octri.call`.

#include <stdint.h>
#include <alloca.h>

#define MICROPY_CONFIG_ROM_LEVEL                (MICROPY_CONFIG_ROM_LEVEL_EXTRA_FEATURES)

#define MICROPY_ENABLE_COMPILER                 (1)
#define MICROPY_ENABLE_GC                       (1)
#define MICROPY_ENABLE_PYSTACK                  (1)
#define MICROPY_STACK_CHECK                     (1)
#define MICROPY_ENABLE_VM_ABORT                 (1)
#define MICROPY_KBD_EXCEPTION                   (0)
#define MICROPY_HELPER_REPL                     (0)
#define MICROPY_ENABLE_EXTERNAL_IMPORT          (0)
#define MICROPY_PERSISTENT_CODE_LOAD            (0)
#define MICROPY_ERROR_REPORTING                 (MICROPY_ERROR_REPORTING_DETAILED)
#define MICROPY_WARNINGS                        (0)
#define MICROPY_ALLOC_PATH_MAX                  (256)

// 64-bit ints overflow with an error instead of growing: a bignum power can
// run for seconds inside one C call, out of reach of the VM hook below.
#define MICROPY_LONGINT_IMPL                    (MICROPY_LONGINT_IMPL_LONGLONG)
#define MICROPY_FLOAT_IMPL                      (MICROPY_FLOAT_IMPL_DOUBLE)
#define MICROPY_USE_INTERNAL_ERRNO              (1)
#define MICROPY_USE_INTERNAL_PRINTF             (0)

#define MICROPY_VFS                             (0)
#define MICROPY_READER_VFS                      (0)
#define MICROPY_PY_OS                           (0)
// json needs StringIO; `io.open` is the builtin open below, which refuses.
#define MICROPY_PY_IO                           (1)
#define MICROPY_PY_SYS_STDFILES                 (0)
#define MICROPY_PY_SYS_STDIO_BUFFER             (0)
#define MICROPY_PY_SYS_SETTRACE                 (0)
#define MICROPY_PY_SYS_PATH                     (0)
#define MICROPY_PY_SYS_ARGV                     (0)
#define MICROPY_PY_BUILTINS_INPUT               (0)
#define MICROPY_PY_BUILTINS_HELP                (0)
#define MICROPY_PY_TIME                         (0)
#define MICROPY_PY_RANDOM                       (0)
#define MICROPY_PY_SELECT                       (0)
#define MICROPY_PY_ASYNCIO                      (0)
#define MICROPY_PY_THREAD                       (0)
#define MICROPY_PY_MACHINE                      (0)
#define MICROPY_PY_UCTYPES                      (0)
#define MICROPY_PY_DEFLATE                      (0)
#define MICROPY_PY_BINASCII                     (0)
#define MICROPY_PY_HASHLIB                      (0)
#define MICROPY_PY_CRYPTOLIB                    (0)
#define MICROPY_PY_FRAMEBUF                     (0)
#define MICROPY_PY_PLATFORM                     (0)
#define MICROPY_PY_VFS                          (0)
#define MICROPY_PY_ERRNO                        (0)
#define MICROPY_PY_MICROPYTHON_HEAP_LOCKED      (0)

#define MICROPY_PY_JSON                         (1)
#define MICROPY_PY_RE                           (1)
#define MICROPY_PY_COLLECTIONS                  (1)
#define MICROPY_PY_MATH                         (1)

#define MICROPY_PY_SYS_PLATFORM                 "octri"
#define MICROPY_HW_BOARD_NAME                   "octri code mode"
#define MICROPY_HW_MCU_NAME                     "wasm"

// Every 64 backward jumps and returns, ask the host whether time is up. A yes
// aborts to the top level past every Python handler, so `except:` cannot keep
// a script alive.
#define MICROPY_VM_HOOK_COUNT                   (64)
#define MICROPY_VM_HOOK_INIT                    static unsigned int vm_hook_divisor = MICROPY_VM_HOOK_COUNT;
#define MICROPY_VM_HOOK_POLL                    if (--vm_hook_divisor == 0) { \
        vm_hook_divisor = MICROPY_VM_HOOK_COUNT; \
        extern void octri_vm_hook(void); \
        octri_vm_hook(); \
}
#define MICROPY_VM_HOOK_LOOP                    MICROPY_VM_HOOK_POLL
#define MICROPY_VM_HOOK_RETURN                  MICROPY_VM_HOOK_POLL

#define MICROPY_MPHALPORT_H                     "mphalport.h"

#define MP_SSIZE_MAX                            (0x7fffffff)
typedef long mp_off_t;
