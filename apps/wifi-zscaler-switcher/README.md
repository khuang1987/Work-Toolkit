# Wi-Fi Zscaler Switcher

This small Windows tool performs the following sequence:

1. Connect to the saved Wi-Fi profile for the main router, which does not use the bypass router.
2. Wait for the Zscaler client to establish its tunnel.
3. Retry an HTTP/HTTPS request to a company resource.
4. Connect back to the saved Wi-Fi profile for the bypass router.
5. Optionally test the same company resource again after returning to the bypass Wi-Fi.

The script does not change DNS, DHCP, the Windows default gateway, Zscaler settings, or Wi-Fi passwords. It only asks Windows to connect to two already-saved Wi-Fi profiles.

## One-time setup

1. Connect to both Wi-Fi networks manually once and save both profiles in Windows.
2. The tool is preconfigured for the two profiles supplied:

```powershell
@{
    DirectSsid     = 'Guest Wi-Fi 2302'
    BypassSsid     = 'FBI Surveillance Van #4'
    CompanyTestUrl = 'https://khplm.medtronic.com.cn/Windchill/app/'
    ExpectedText   = ''
    InterfaceAlias = 'Wi-Fi'
}
```

`Guest Wi-Fi 2302` is the direct/main-router Wi-Fi used to establish Zscaler. `FBI Surveillance Van #4` is the bypass-router Wi-Fi to which the tool returns. No SSID selection is shown during normal one-click operation.

`CompanyTestUrl` should be a company application, intranet page, or health endpoint that is useful for proving that Zscaler is working. The configured Windchill URL is suitable if it is not reachable outside the company network. The `#/ptc1/homepage` part is a browser fragment and is intentionally omitted from the HTTP test; fragments are not sent to the server. Do not use an ordinary public web page because it can succeed without the Zscaler tunnel.

If the endpoint requires browser sign-in, an HTTP `401` or `403` response is treated as reachable. For a stronger check, set `ExpectedText` to a stable literal string from the expected response. You can also pass `-ManualConfirmation` to open the URL in the browser before the automated check.

## Run

Double-click `Run-WiFi-Zscaler-Switcher.bat`, or run it from PowerShell:

```powershell
pwsh.exe -NoLogo -NoProfile -File .\Switch-ZscalerWiFi.ps1
```

Settings can be supplied on the command line and override the configuration file:

```powershell
pwsh.exe -NoLogo -NoProfile -File .\Switch-ZscalerWiFi.ps1 `
    -DirectSsid 'Guest Wi-Fi 2302' `
    -BypassSsid 'FBI Surveillance Van #4' `
    -CompanyTestUrl 'https://khplm.medtronic.com.cn/Windchill/app/' `
    -ExpectedText 'OK'
```

The direct-network phase has a hard maximum of 180 seconds, including Wi-Fi association, the Zscaler warm-up, and the company endpoint test. Whether the test succeeds, times out, or fails, the script then attempts to return to `FBI Surveillance Van #4`.

Use `-NoPostReturnTest` only when the company endpoint cannot be tested after the Wi-Fi switch. The computer is still left on the bypass Wi-Fi.

## Failure behavior

The return to the bypass Wi-Fi is in a `finally` block. Therefore, a failed direct connection or failed company test still causes the script to attempt the return connection.

Exit codes:

- `0`: Direct test passed and the bypass Wi-Fi was restored. The post-return test also passed, or was skipped.
- `1`: Direct Wi-Fi or company-resource test failed, but the bypass Wi-Fi was restored.
- `2`: The script could not confirm the return to the bypass Wi-Fi.
- `3`: The bypass Wi-Fi was restored, but the post-return company-resource test failed.

For exit code `3`, the script intentionally leaves the computer on the bypass Wi-Fi. It does not automatically switch back to the direct Wi-Fi, because the bypass network is the requested home-network state.

## Notes

- The Wi-Fi profile names are case-sensitive for clarity and must already exist in Windows. The script never stores or asks for their passwords.
- Do not enable two DHCP servers on the same LAN to support this workflow. Separate SSIDs or separate network segments are safer.
- The script does not inspect undocumented Zscaler process names. The company-resource test is the practical verification of the tunnel from the user's network path.
- If the wireless adapter is not named `Wi-Fi`, find its name with `Get-NetAdapter` and update `InterfaceAlias`.
