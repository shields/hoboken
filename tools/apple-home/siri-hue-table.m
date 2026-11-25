// Copyright © 2026 Michael Shields
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Siri's table of named colors. HomeAutomationInternal.framework (SiriOntology)
// keeps an array of 712 entries, keyed by the HueSemantic enum, each with a
// hue in degrees, a saturation in percent, and a brightness in percent. This
// program calls the function that builds the array and reads the global it
// fills, then prints one TSV row per entry. It runs no Siri code and sends
// nothing to HomeKit.
//
// BUILD-SPECIFIC: the framework lives in the dyld shared cache and has no
// exported symbol for either the builder or the array, so both are addressed
// by their unslid (static) addresses in the cache image. Those addresses are
// valid for macOS 27.2.1 (26B131) on arm64e only. On another build, find the
// two addresses with siri-find-initializer.sh and pass them as arguments:
//
//   siri-hue-table [<initializer> <global>]    (hex, unslid)
//
// The element layout, 32 bytes each, is a uint16 key, 6 bytes of padding, and
// three doubles, after a 32-byte array header whose count is at offset 0x10.
// The program stops if the count is not 712 or a key is out of range.

#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <stdint.h>
#import <sys/sysctl.h>

extern const void *_dyld_get_shared_cache_range(size_t *);

#define EXPECTED_BUILD "26B131"
#define UNSLID_INITIALIZER 0x2454FCE4CUL
#define UNSLID_GLOBAL 0x272d41fb8UL
#define UNSLID_CACHE_BASE 0x180000000UL
#define EXPECTED_COUNT 712

typedef struct {
  uint64_t a, b;
} SwiftString;
typedef SwiftString __attribute__((swiftcall)) (*RawValueGetter)(void *ctx __attribute__((swift_context)));

// Decodes a Swift String that is returned in two registers: either a small
// string of up to 15 UTF-8 bytes stored inline, or a pointer to a native
// string whose bytes start 0x20 after the pointer.
static NSString *swiftString(SwiftString s) {
  if ((s.b >> 60) == 0xe) {
    int length = (s.b >> 56) & 0xf;
    char buf[17] = {0};
    memcpy(buf, &s.a, 8);
    uint64_t hi = s.b & 0x00ffffffffffffffULL;
    memcpy(buf + 8, &hi, 7);
    buf[length] = 0;
    return [NSString stringWithUTF8String:buf];
  }
  uint64_t count = s.a & 0xffffffffffffULL;
  const char *p = (const char *)((s.b & 0x0fffffffffffffffULL) + 0x20);
  return [[NSString alloc] initWithBytes:p length:count encoding:NSUTF8StringEncoding];
}

int main(int argc, char **argv) {
  @autoreleasepool {
    uintptr_t initializer = UNSLID_INITIALIZER, global = UNSLID_GLOBAL;
    if (argc == 3) {
      initializer = strtoull(argv[1], NULL, 16);
      global = strtoull(argv[2], NULL, 16);
    } else if (argc != 1) {
      fprintf(stderr, "usage: %s [<initializer> <global>]\n", argv[0]);
      return 2;
    } else {
      char build[32] = {0};
      size_t size = sizeof build;
      sysctlbyname("kern.osversion", build, &size, NULL, 0);
      if (strcmp(build, EXPECTED_BUILD) != 0) {
        fprintf(stderr,
                "macOS build %s: the built-in addresses are for %s. Find the addresses with siri-find-initializer.sh and "
                "pass them as arguments.\n",
                build, EXPECTED_BUILD);
        return 2;
      }
    }
    void *handle = dlopen("/System/Library/PrivateFrameworks/HomeAutomationInternal.framework/HomeAutomationInternal",
                          RTLD_NOW);
    if (!handle) {
      fprintf(stderr, "dlopen failed: %s\n", dlerror());
      return 1;
    }
    size_t length;
    uintptr_t base = (uintptr_t)_dyld_get_shared_cache_range(&length);
    uintptr_t slide = base - UNSLID_CACHE_BASE;
    RawValueGetter rawValue = (RawValueGetter)dlsym(handle, "$s22HomeAutomationInternal11HueSemanticO8rawValueSSvg");
    if (!rawValue) {
      fprintf(stderr, "HueSemantic.rawValue.getter not found\n");
      return 1;
    }
    ((void (*)(void))(initializer + slide))();
    uint8_t *array = *(uint8_t **)(global + slide);
    uint64_t count = *(uint64_t *)(array + 0x10);
    if (count != EXPECTED_COUNT) {
      fprintf(stderr, "found %llu entries, expected %d\n", count, EXPECTED_COUNT);
      return 1;
    }
    printf("index\tkey\tname\thue\tsaturation\tbrightness\n");
    for (uint64_t i = 0; i < count; i++) {
      uint8_t *entry = array + 0x20 + 32 * i;
      uint16_t key = *(uint16_t *)entry;
      if (key >= EXPECTED_COUNT) {
        fprintf(stderr, "entry %llu has key %u\n", i, key);
        return 1;
      }
      double *hsb = (double *)(entry + 8);
      NSString *name = swiftString(rawValue(&key));
      printf("%llu\t%u\t%s\t%.1f\t%.1f\t%.1f\n", i, key, [name UTF8String], hsb[0], hsb[1], hsb[2]);
    }
  }
  return 0;
}
