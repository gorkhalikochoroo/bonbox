/**
 * inAppBrowserName — Instagram's, Facebook's and Messenger's own browsers,
 * where Google refuses its sign-in ("disallowed_useragent"). Real user-agent
 * strings of each kind, and the ordinary browsers that must never match.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { inAppBrowserName } from "./inAppBrowser";

const IN_APP = {
  Instagram: {
    "Instagram, iPhone":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 337.0.3.23.54 (iPhone15,2; iOS 17_5_1; da_DK; da; scale=3.00; 1179x2556; 614406087; IABMV/1)",
    "Instagram, iPhone (older build)":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 290.0.0.13.76 (iPhone12,1; iOS 16_5; en_US; en-US; scale=2.00; 828x1792; 490524866) NW/3",
    "Instagram, Android":
      "Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.122 Mobile Safari/537.36 Instagram 337.0.0.35.102 Android (34/14; 480dpi; 1080x2340; samsung; SM-S918B; dm3q; qcom; da_DK; 614406103)",
  },
  Facebook: {
    "Facebook, iPhone":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/472.0.0.45.110;FBBV/622436612;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/17.5.1;FBSS/3;FBID/phone;FBLC/da_DK;FBOP/5;FBRV/625214164]",
    "Facebook, iPad":
      "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBDV/iPad13,1;FBMD/iPad;FBSN/iPadOS;FBSV/16.6;FBSS/2;FBID/tablet;FBLC/en_US;FBOP/5]",
    "Facebook, Android":
      "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/127.0.6533.103 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/478.0.0.42.109;]",
  },
  Messenger: {
    "Messenger, iPhone":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/MessengerForiOS;FBAV/458.0.0.36.108;FBBV/599245498;FBDV/iPhone14,7;FBMD/iPhone;FBSN/iOS;FBSV/17.4.1;FBSS/3;FBCR/;FBID/phone;FBLC/da_DK;FBOP/5;FBRV/0]",
    "Messenger, Android":
      "Mozilla/5.0 (Linux; Android 13; SM-A536B Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.6045.163 Mobile Safari/537.36 [FB_IAB/Orca-Android;FBAV/439.0.0.29.119;]",
  },
};

const ORDINARY = {
  "Safari, iPhone":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  "Chrome, iPhone":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1",
  "Safari, iPad (desktop mode)":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  "Chrome, Android":
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.122 Mobile Safari/537.36",
  "Samsung Internet, Android":
    "Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
  "Firefox, Android":
    "Mozilla/5.0 (Android 14; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0",
  "Chrome, desktop":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

afterEach(() => vi.restoreAllMocks());

describe("inAppBrowserName — the three Meta in-app browsers", () => {
  for (const [app, uas] of Object.entries(IN_APP)) {
    for (const [name, ua] of Object.entries(uas)) {
      it(`${name} → ${app}`, () => {
        expect(inAppBrowserName(ua)).toBe(app);
      });
    }
  }
});

describe("inAppBrowserName — ordinary browsers are never an in-app browser", () => {
  for (const [name, ua] of Object.entries(ORDINARY)) {
    it(`${name} → null`, () => {
      expect(inAppBrowserName(ua)).toBeNull();
    });
  }
  it("an empty user agent → null", () => {
    expect(inAppBrowserName("")).toBeNull();
  });
});

describe("inAppBrowserName — reads navigator.userAgent when given none", () => {
  it("Instagram's user agent on the device → Instagram", () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(IN_APP.Instagram["Instagram, iPhone"]);
    expect(inAppBrowserName()).toBe("Instagram");
  });
  it("Safari on the device → null", () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(ORDINARY["Safari, iPhone"]);
    expect(inAppBrowserName()).toBeNull();
  });
});
