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

// The Home app's default color palettes. Prints the swatches of
// +[HFColorPalette defaultColorPaletteOfType:] 0 (colors) and 1
// (temperatures) as hue, saturation, brightness, and the temperature a swatch
// carries if it has one.

#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <objc/message.h>
#import <objc/runtime.h>

static id send0(id o, const char *sel) { return ((id (*)(id, SEL))objc_msgSend)(o, sel_registerName(sel)); }

static void hsb(id rgb, double *h, double *s, double *b) {
  float fh = 0, fs = 0, fb = 0;
  ((void (*)(id, SEL, float *, float *, float *))objc_msgSend)(rgb, sel_registerName("getHue:saturation:brightness:"), &fh,
                                                               &fs, &fb);
  *h = fh;
  *s = fs;
  *b = fb;
}

int main(void) {
  @autoreleasepool {
    if (!dlopen("/System/iOSSupport/System/Library/PrivateFrameworks/Home.framework/Home", RTLD_NOW)) {
      printf("dlopen failed: %s\n", dlerror());
      return 1;
    }
    Class palette = NSClassFromString(@"HFColorPalette");
    const char *names[] = {"RGB palette (type 0)", "temperature palette (type 1)"};
    for (long type = 0; type < 2; type++) {
      id p = ((id (*)(id, SEL, long))objc_msgSend)(palette, sel_registerName("defaultColorPaletteOfType:"), type);
      printf("%s\n", names[type]);
      int i = 0;
      for (id color in (NSArray *)send0(p, "colors")) {
        id collection = send0(color, "colorValue");
        id rgb = send0(collection, "RGBColor");
        id temp = send0(collection, "temperatureColor");
        double h = 0, s = 0, b = 0;
        hsb(rgb, &h, &s, &b);
        double mired = temp ? ((float (*)(id, SEL))objc_msgSend)(temp, sel_registerName("temperatureInMired")) : 0;
        printf("  %d  hue %7.3f  sat %6.3f  bri %5.3f  %s\n", ++i, h * 360.0, s * 100.0, b,
               temp ? [[NSString stringWithFormat:@"temperature %.2f mireds (%.0f K)", mired, 1e6 / mired] UTF8String]
                    : "no temperature");
      }
    }
  }
  return 0;
}
