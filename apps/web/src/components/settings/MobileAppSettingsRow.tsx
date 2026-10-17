import { AndroidIcon, AppleIcon } from "../Icons";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { QRCodeSvg } from "../ui/qr-code";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const stores = [
  {
    label: "iPhone and iPad",
    store: "TestFlight",
    url: undefined,
    Icon: AppleIcon,
  },
  {
    label: "Android",
    store: "Android releases",
    url: "https://github.com/incognitojam/styal/releases?q=android-",
    Icon: AndroidIcon,
  },
];

export function MobileAppSettingsRow() {
  return (
    <SettingsRow
      {...searchableSetting("mobile-app")}
      description="Connect to your server from your phone or tablet."
      control={
        <div className="flex items-center gap-2">
          {stores.map(({ label, store, url, Icon }) => (
            <Popover key={store}>
              <PopoverTrigger render={<Button size="sm" variant="outline" />}>
                <Icon />
                {label}
              </PopoverTrigger>
              <PopoverPopup align="end">
                <div className="flex flex-col items-center gap-3">
                  <PopoverTitle>{store}</PopoverTitle>
                  <p className="text-xs text-muted-foreground">
                    {url ? "Scan with your phone camera." : "TestFlight is invite-only."}
                  </p>
                  {url && (
                    <>
                      <div className="rounded-lg bg-white p-1.5">
                        <QRCodeSvg
                          value={url}
                          size={128}
                          level="M"
                          marginSize={1}
                          title={`${store} link`}
                        />
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        render={<a href={url} target="_blank" rel="noreferrer noopener" />}
                      >
                        Open {store}
                      </Button>
                    </>
                  )}
                </div>
              </PopoverPopup>
            </Popover>
          ))}
        </div>
      }
    />
  );
}
