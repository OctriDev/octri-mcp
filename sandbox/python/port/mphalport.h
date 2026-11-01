#include "py/obj.h"

// No stdin and no clocks: scripts read nothing and cannot sleep.
#define mp_hal_stdin_rx_chr() (0)
static inline mp_uint_t mp_hal_ticks_ms(void) {
    return 0;
}
static inline void mp_hal_set_interrupt_char(char c) {
    (void)c;
}
mp_uint_t mp_hal_stdout_tx_strn(const char *str, size_t len);
