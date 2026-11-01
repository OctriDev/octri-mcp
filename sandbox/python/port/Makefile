# Builds the code mode Python sandbox: MicroPython core + this port, linked by
# emscripten into an ES module with its wasm beside it. Run through build.sh,
# which pins both MicroPython and emscripten.

TOP ?= ../micropython
BUILD ?= build

include $(TOP)/py/mkenv.mk

QSTR_DEFS = qstrdefsport.h

include $(TOP)/py/py.mk
include $(TOP)/extmod/extmod.mk

CC = emcc
LD = emcc

INC += -I.
INC += -I$(TOP)
INC += -I$(BUILD)

CFLAGS += -std=c99 -Wall -Werror -Wdouble-promotion -Wfloat-conversion
CFLAGS += -Os -DNDEBUG
CFLAGS += $(INC)

# No filesystem, no dynamic code in the glue (Workers forbid it), memory that
# may grow only to a fixed ceiling, and Asyncify so `_octri.call` can wait on
# the host without the script seeing a coroutine.
JSFLAGS += -s MODULARIZE -s EXPORT_ES6 -s EXPORT_NAME=createOctriPython
# "shell" is the plain-JS fallback: Node and Cloudflare Workers both land there,
# with no Node imports in the glue. The host always supplies the wasm itself.
JSFLAGS += -s ENVIRONMENT=web,shell
JSFLAGS += -s FILESYSTEM=0
JSFLAGS += -s DYNAMIC_EXECUTION=0
JSFLAGS += -s ASYNCIFY
JSFLAGS += -s SUPPORT_LONGJMP=emscripten
JSFLAGS += -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=4MB -s MAXIMUM_MEMORY=48MB
JSFLAGS += -s ABORTING_MALLOC=0
JSFLAGS += -s STACK_SIZE=1MB
JSFLAGS += -Os -s ASSERTIONS=0
JSFLAGS += -s EXPORTED_FUNCTIONS=_octri_init,_octri_exec,_malloc,_free
JSFLAGS += -s EXPORTED_RUNTIME_METHODS=ccall,UTF8ToString,stringToUTF8,lengthBytesUTF8
JSFLAGS += --js-library library.js

SRC_C = main.c
SRC_QSTR += $(SRC_C)

OBJ += $(PY_O)
OBJ += $(addprefix $(BUILD)/, $(SRC_C:.c=.o))

all: $(BUILD)/octri-python.mjs

$(BUILD)/octri-python.mjs: $(OBJ) library.js
	$(ECHO) "LINK $@"
	$(Q)emcc $(LDFLAGS) -o $@ $(OBJ) $(JSFLAGS)

include $(TOP)/py/mkrules.mk
