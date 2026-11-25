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

// How the Home app reads a light's characteristics back into a color. Gives
// Apple's -[HFColorControlItem valueForCharacteristicValues:] Hue, Saturation,
// and ColorTemperature values and prints which color primitives result and
// which is preferred, which decides whether the Home app shows a color or a
// temperature.

#import "home-color-item.h"

static void rd(const char *label, NSDictionary *vals) {
  id r = ((id (*)(id, SEL, id))objc_msgSend)(item, sel_registerName("valueForCharacteristicValues:"), vals);
  if (!r) {
    printf("  %-48s -> nil\n", label);
    return;
  }
  id pref = ((id (*)(id, SEL))objc_msgSend)(r, sel_registerName("preferredColorPrimitive"));
  NSSet *prims = ((id (*)(id, SEL))objc_msgSend)(r, sel_registerName("colorPrimitives"));
  printf("  %-48s -> prims=%lu preferred=%s\n", label, (unsigned long)prims.count,
         [NSStringFromClass([pref class]) UTF8String]);
  printf("        %s\n", [describe(r) UTF8String]);
}

int main(void) {
  @autoreleasepool {
    setupItem(NO);
    NSString *H = kHue, *S = kSaturation, *C = kColorTemperature;
    gTypes = [NSSet setWithObjects:H, S, C, nil];
    id prof = ((id (*)(id, SEL))objc_msgSend)(item, sel_registerName("colorProfile"));
    printf("colorProfile min=%g max=%g\n",
           ((float (*)(id, SEL))objc_msgSend)(prof, sel_registerName("minimumTemperature")),
           ((float (*)(id, SEL))objc_msgSend)(prof, sel_registerName("maximumTemperature")));
    printf("--- Hue+Sat+CT light, read back\n");
    rd("H=228 S=56 CT=250", @{H : @228, S : @56, C : @250});
    rd("H=0 S=0 CT=250", @{H : @0, S : @0, C : @250});
    rd("H=228 S=56 CT=140 (min)", @{H : @228, S : @56, C : @140});
    rd("H=30 S=66 CT=140 (min)", @{H : @30, S : @66, C : @140});
    {
      id t = temp(140);
      id r = ((id (*)(id, SEL))objc_msgSend)(t, sel_registerName("hf_RGBColorRepresentation"));
      float h, s, b;
      ((void (*)(id, SEL, float *, float *, float *))objc_msgSend)(r, sel_registerName("getHue:saturation:brightness:"), &h,
                                                                   &s, &b);
      printf("  temp 140 mired rgb rep hue %.3f sat %.3f\n", h * 360, s * 100);
    }
    rd("H=222 S=20 CT=140 (matches 140 mired rgb ~)", @{H : @222, S : @20, C : @140});
    rd("H=228 S=56 only (no CT value)", @{H : @228, S : @56});
    rd("H only", @{H : @228});
    rd("CT=300 only", @{C : @300});
    rd("H=0 S=0 CT=500", @{H : @0, S : @0, C : @500});
    gTypes = [NSSet setWithObjects:H, S, nil];
    printf("--- Hue+Sat only light\n");
    rd("H=228 S=56", @{H : @228, S : @56});
    rd("H=0 S=0", @{H : @0, S : @0});
    gTypes = [NSSet setWithObjects:C, nil];
    printf("--- CT-only light\n");
    rd("CT=300", @{C : @300});
    gCTmin = nil;
    gTypes = [NSSet setWithObjects:H, S, nil];
    id prof2 = ((id (*)(id, SEL))objc_msgSend)(item, sel_registerName("colorProfile"));
    printf("H/S-only colorProfile = %s\n", prof2 ? "non-nil" : "nil");
  }
}
