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

// What the Home app's color control writes. Feeds colors to Apple's
// -[HFColorControlItem characteristicValuesForValue:] on stub lights with Hue
// and Saturation only, with ColorTemperature added, and with ColorTemperature
// only, and prints the characteristics and values it would write. Also does
// this for every swatch of the Home app's default palettes.

#import "home-color-item.h"

static void run(const char *label, id collection) {
  printf("  %-44s -> {%s}\n", label, [writes(collection, @", ", NO) UTF8String]);
}

int main(void) {
  @autoreleasepool {
    setupItem(NO);
    NSString *H = kHue, *S = kSaturation, *C = kColorTemperature;
    struct {
      const char *name;
      NSSet *types;
    } cfgs[] = {
        {"(a) Hue+Saturation only", [NSSet setWithObjects:H, S, nil]},
        {"(b) Hue+Saturation+ColorTemperature (140-500 step 1)", [NSSet setWithObjects:H, S, C, nil]},
        {"(c) ColorTemperature only (140-500 step 1)", [NSSet setWithObjects:C, nil]},
    };
    for (int i = 0; i < 3; i++) {
      gTypes = cfgs[i].types;
      printf("%s: supportsRGBColor=%d\n", cfgs[i].name,
             ((BOOL (*)(id, SEL))objc_msgSend)(item, sel_registerName("supportsRGBColor")));
      run("RGB 228/56", coll(@[ rgb(228, 56, 1) ]));
      run("RGB 28/23", coll(@[ rgb(28, 23, 1) ]));
      run("RGB 221.8/20.2 (cool palette 1)", coll(@[ rgb(221.8, 20.2, 1) ]));
      run("RGB 0/0", coll(@[ rgb(0, 0, 1) ]));
      run("RGB 359.6/99.5", coll(@[ rgb(359.6, 99.5, 1) ]));
      run("RGB 240/100", coll(@[ rgb(240, 100, 1) ]));
      run("RGB 28.4/23.5 (rounding)", coll(@[ rgb(28.4, 23.5, 1) ]));
      run("RGB 28.6/22.5 (rounding)", coll(@[ rgb(28.6, 22.5, 1) ]));
      run("TEMP 366", coll(@[ temp(366) ]));
      run("TEMP 250", coll(@[ temp(250) ]));
      run("TEMP 100 (below min)", coll(@[ temp(100) ]));
      run("TEMP 600 (above max)", coll(@[ temp(600) ]));
      run("TEMP 250.4", coll(@[ temp(250.4) ]));
      run("TEMP 250.5", coll(@[ temp(250.5) ]));
      run("BOTH rgb 28/23 + temp 366", coll(@[ rgb(28, 23, 1), temp(366) ]));
      run("BOTH rgb 100/50 + temp 300", coll(@[ rgb(100, 50, 1), temp(300) ]));
    }
    for (long type = 0; type < 2; type++) {
      id p = ((id (*)(id, SEL, long))objc_msgSend)(NSClassFromString(@"HFColorPalette"),
                                                    sel_registerName("defaultColorPaletteOfType:"), type);
      for (int cfg = 0; cfg < 3; cfg++) {
        gTypes = cfgs[cfg].types;
        printf("palette type %ld on %s\n", type, cfgs[cfg].name);
        int i = 0;
        for (id c in (NSArray *)((id (*)(id, SEL))objc_msgSend)(p, sel_registerName("colors"))) {
          char lab[64];
          snprintf(lab, sizeof lab, "swatch %d", ++i);
          run(lab, ((id (*)(id, SEL))objc_msgSend)(c, sel_registerName("colorValue")));
        }
      }
    }
  }
}
