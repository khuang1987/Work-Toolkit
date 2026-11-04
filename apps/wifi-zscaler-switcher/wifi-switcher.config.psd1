@{
    # Fixed profiles for one-click operation. Do not put Wi-Fi passwords here.
    DirectSsid     = 'Guest Wi-Fi 2302'
    BypassSsid     = 'FBI Surveillance Van #4'

    # Use a company resource that is meaningful only when Zscaler is working.
    CompanyTestUrl = 'https://khplm.medtronic.com.cn/Windchill/app/'

    # Optional literal text expected in the HTTP response. Leave empty if not needed.
    ExpectedText   = ''

    # Change this if Get-NetAdapter shows a different wireless interface name.
    InterfaceAlias = 'Wi-Fi'
}
