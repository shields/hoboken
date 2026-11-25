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

// How the Home app's color control decides between Hue/Saturation and
// ColorTemperature, and how it limits and rounds what it writes. Varies the
// characteristics the stub light has, its ColorTemperature range, and the
// step sizes of its characteristics.

#import "home-color-item.h"

static NSString *wr(id collection) { return writes(collection, @" ", YES); }

int main(void) {
  @autoreleasepool {
    setupItem(NO);
    NSString *H = kHue, *S = kSaturation, *C = kColorTemperature;
    NSArray *sets = @[
      [NSSet setWithObject:H], [NSSet setWithObject:S], [NSSet setWithObjects:H, S, nil], [NSSet setWithObjects:C, nil],
      [NSSet setWithObjects:H, C, nil]
    ];
    NSArray *names = @[ @"{Hue}", @"{Saturation}", @"{Hue,Sat}", @"{CT}", @"{Hue,CT}" ];
    for (int i = 0; i < 5; i++) {
      gTypes = sets[i];
      printf("%s supportsRGBColor=%d  RGB(100,50) -> {%s}  TEMP(300) -> {%s}\n", [names[i] UTF8String],
             ((BOOL (*)(id, SEL))objc_msgSend)(item, sel_registerName("supportsRGBColor")),
             [wr(coll(@[ rgb(100, 50, 1) ])) UTF8String], [wr(coll(@[ temp(300) ])) UTF8String]);
    }
    gTypes = [NSSet setWithObjects:H, S, C, nil];
    struct {
      int mn, mx;
    } r[] = {{153, 500}, {153, 370}, {200, 454}, {50, 400}};
    for (int i = 0; i < 4; i++) {
      gCTmin = @(r[i].mn);
      gCTmax = @(r[i].mx);
      printf("CT range %d..%d: TEMP 366 -> {%s}  TEMP 100 -> {%s}  TEMP 600 -> {%s}  palette3 warm white -> {%s}\n", r[i].mn,
             r[i].mx, [wr(coll(@[ temp(366) ])) UTF8String], [wr(coll(@[ temp(100) ])) UTF8String],
             [wr(coll(@[ temp(600) ])) UTF8String], [wr(coll(@[ rgb(28, 23, 1), temp(366) ])) UTF8String]);
      id prof = ((id (*)(id, SEL))objc_msgSend)(item, sel_registerName("colorProfile"));
      id adj = ((id (*)(id, SEL, id))objc_msgSend)(coll(@[ rgb(28, 23, 1), temp(366) ]),
                                                   sel_registerName("colorByAdjustingForProfile:"), prof);
      printf("   colorByAdjustingForProfile(warm white) -> %s ; item writes {%s}\n", [describe(adj) UTF8String],
             [wr(adj) UTF8String]);
    }
    gCTmin = @140;
    gCTmax = @500;
    gCTstep = @10;
    gHueStep = @5;
    gSatStep = @5;
    printf("CT step 10, hue/sat step 5: TEMP 366 -> {%s}; RGB(228,56) -> {%s}; RGB(28,23)->{%s}\n",
           [wr(coll(@[ temp(366) ])) UTF8String], [wr(coll(@[ rgb(228, 56, 1) ])) UTF8String],
           [wr(coll(@[ rgb(28, 23, 1) ])) UTF8String]);
    gCTstep = @1;
    gHueStep = @1;
    gSatStep = @1;
    gTypes = [NSSet setWithObjects:H, S, nil];
    for (double hv = 10.5; hv < 14; hv += 1.0) {
      printf("hue %.1f sat %.1f -> {%s}\n", hv, hv, [wr(coll(@[ rgb(hv, hv, 1) ])) UTF8String]);
    }
    printf("hue 359.9 -> {%s}  hue 360 -> {%s}\n", [wr(coll(@[ rgb(359.9, 50, 1) ])) UTF8String],
           [wr(coll(@[ rgb(360, 50, 1) ])) UTF8String]);
  }
}
