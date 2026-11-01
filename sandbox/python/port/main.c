// Entry points of the code mode Python sandbox.
//
// The host (JavaScript) calls octri_init once, then octri_exec once per
// instance: every run gets a fresh module instance, so nothing a script does
// outlives it. The only imports are the four functions in library.js; the
// only module a script can use to reach the host is `_octri`.

#include <stdlib.h>
#include <string.h>

#include <emscripten.h>

#include "py/builtin.h"
#include "py/compile.h"
#include "py/gc.h"
#include "py/mperrno.h"
#include "py/mphal.h"
#include "py/runtime.h"
#include "py/stackctrl.h"

// Implemented in library.js.
extern void octri_write(int stream, const char *str, size_t len);
extern int octri_should_stop(void);
extern char *octri_call(const char *name, size_t name_len, const char *args, size_t args_len, size_t *out_len);
extern void octri_result(const char *str, size_t len);

#define STREAM_OUT (1)
#define STREAM_ERR (2)

// Below emscripten's STACK_SIZE (see the Makefile), so deep recursion raises
// RuntimeError before it can overflow the real stack.
#define CSTACK_LIMIT (768 * 1024)

mp_uint_t mp_hal_stdout_tx_strn(const char *str, size_t len) {
    octri_write(STREAM_OUT, str, len);
    return len;
}

void mp_hal_stdout_tx_strn_cooked(const char *str, size_t len) {
    octri_write(STREAM_OUT, str, len);
}

static void stderr_strn(void *env, const char *str, size_t len) {
    (void)env;
    octri_write(STREAM_ERR, str, len);
}

static const mp_print_t stderr_print = {NULL, stderr_strn};

void octri_vm_hook(void) {
    if (octri_should_stop()) {
        mp_sched_vm_abort();
    }
}

// ─── _octri module ───────────────────────────────────────────────────────────

// _octri.call(name, args_json) -> envelope_json. Blocks (via Asyncify) while
// the host runs the operation through its own call path.
static mp_obj_t mod_octri_call(mp_obj_t name_in, mp_obj_t args_in) {
    size_t name_len, args_len;
    const char *name = mp_obj_str_get_data(name_in, &name_len);
    const char *args = mp_obj_str_get_data(args_in, &args_len);
    size_t out_len = 0;
    char *out = octri_call(name, name_len, args, args_len, &out_len);
    if (out == NULL) {
        mp_raise_msg(&mp_type_RuntimeError, MP_ERROR_TEXT("the host refused the call"));
    }
    mp_obj_t result = mp_obj_new_str(out, out_len);
    free(out);
    return result;
}
static MP_DEFINE_CONST_FUN_OBJ_2(mod_octri_call_obj, mod_octri_call);

// _octri.result(json): the script's return value, already serialised.
static mp_obj_t mod_octri_result(mp_obj_t value_in) {
    size_t len;
    const char *value = mp_obj_str_get_data(value_in, &len);
    octri_result(value, len);
    return mp_const_none;
}
static MP_DEFINE_CONST_FUN_OBJ_1(mod_octri_result_obj, mod_octri_result);

static const mp_rom_map_elem_t mp_module_octri_globals_table[] = {
    { MP_ROM_QSTR(MP_QSTR___name__), MP_ROM_QSTR(MP_QSTR__octri) },
    { MP_ROM_QSTR(MP_QSTR_call), MP_ROM_PTR(&mod_octri_call_obj) },
    { MP_ROM_QSTR(MP_QSTR_result), MP_ROM_PTR(&mod_octri_result_obj) },
};
static MP_DEFINE_CONST_DICT(mp_module_octri_globals, mp_module_octri_globals_table);

const mp_obj_module_t mp_module_octri = {
    .base = { &mp_type_module },
    .globals = (mp_obj_dict_t *)&mp_module_octri_globals,
};

MP_REGISTER_MODULE(MP_QSTR__octri, mp_module_octri);

// ─── Host entry points ───────────────────────────────────────────────────────

EMSCRIPTEN_KEEPALIVE
void octri_init(int heap_size, int pystack_words) {
    mp_cstack_init_with_sp_here(CSTACK_LIMIT);
    mp_obj_t *pystack = (mp_obj_t *)malloc(pystack_words * sizeof(mp_obj_t));
    mp_pystack_init(pystack, pystack + pystack_words);
    char *heap = (char *)malloc(heap_size);
    gc_init(heap, heap + heap_size);
    mp_init();
}

// 0: ran to the end. 1: uncaught exception (traceback on stderr). 2: aborted
// because the host said time was up.
EMSCRIPTEN_KEEPALIVE
int octri_exec(const char *src, size_t len) {
    nlr_buf_t nlr;
    nlr.ret_val = NULL;
    if (nlr_push(&nlr) == 0) {
        nlr_set_abort(&nlr);
        mp_lexer_t *lex = mp_lexer_new_from_str_len(MP_QSTR__lt_script_gt_, src, len, 0);
        qstr source_name = lex->source_name;
        mp_parse_tree_t parse_tree = mp_parse(lex, MP_PARSE_FILE_INPUT);
        mp_obj_t module_fun = mp_compile(&parse_tree, source_name, false);
        mp_call_function_0(module_fun);
        nlr_pop();
        nlr_set_abort(NULL);
        return 0;
    }
    nlr_set_abort(NULL);
    if (nlr.ret_val == NULL) {
        return 2;
    }
    mp_obj_print_exception(&stderr_print, MP_OBJ_FROM_PTR(nlr.ret_val));
    return 1;
}

// ─── Port hooks ──────────────────────────────────────────────────────────────

static void gc_scan_func(void *begin, void *end) {
    gc_collect_root((void **)begin, (void **)end - (void **)begin + 1);
}

void gc_collect(void) {
    gc_collect_start();
    emscripten_scan_stack(gc_scan_func);
    emscripten_scan_registers(gc_scan_func);
    gc_collect_end();
}

mp_lexer_t *mp_lexer_new_from_file(qstr filename) {
    (void)filename;
    mp_raise_OSError(MP_ENOENT);
}

mp_import_stat_t mp_import_stat(const char *path) {
    (void)path;
    return MP_IMPORT_STAT_NO_EXIST;
}

mp_obj_t mp_builtin_open(size_t n_args, const mp_obj_t *args, mp_map_t *kwargs) {
    (void)n_args;
    (void)args;
    (void)kwargs;
    mp_raise_OSError(MP_EPERM);
}
MP_DEFINE_CONST_FUN_OBJ_KW(mp_builtin_open_obj, 1, mp_builtin_open);

void nlr_jump_fail(void *val) {
    (void)val;
    abort();
}

void MP_NORETURN __fatal_error(const char *msg) {
    (void)msg;
    abort();
}

#ifndef NDEBUG
void MP_WEAK __assert_func(const char *file, int line, const char *func, const char *expr) {
    (void)file;
    (void)line;
    (void)func;
    (void)expr;
    abort();
}
#endif
