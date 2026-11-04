[CmdletBinding()]
param(
    [string]$DirectSsid,
    [string]$BypassSsid,
    [string]$CompanyTestUrl,
    [string]$ExpectedText,
    [string]$InterfaceAlias,
    [string]$ConfigPath,
    [int]$ConnectTimeoutSeconds = 60,
    [int]$WarmupSeconds = 10,
    [int]$MaxVpnWaitSeconds = 180,
    [int]$PostReturnTestTimeoutSeconds = 30,
    [switch]$NoPostReturnTest,
    [switch]$ManualConfirmation,
    [switch]$NonInteractive
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:NetshPath = (Get-Command -Name 'netsh.exe' -ErrorAction Stop).Source
$script:InterfaceAliasValue = $null

function Write-Log {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message,
        [ValidateSet('INFO', 'WARN', 'ERROR')]
        [string]$Level = 'INFO'
    )

    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $color = switch ($Level) {
        'WARN' { 'Yellow' }
        'ERROR' { 'Red' }
        default { 'Cyan' }
    }

    Write-Host ('[{0}] [{1}] {2}' -f $timestamp, $Level, $Message) -ForegroundColor $color
}

function Read-Configuration {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return @{}
    }

    try {
        $loaded = Import-PowerShellDataFile -LiteralPath $Path -ErrorAction Stop
    }
    catch {
        throw "Unable to read configuration '$Path': $($_.Exception.Message)"
    }

    if ($loaded -isnot [hashtable]) {
        throw "Configuration '$Path' must contain a PowerShell hashtable."
    }

    return $loaded
}

function Get-ConfiguredText {
    param(
        [AllowNull()]
        [string]$CommandValue,
        [Parameter(Mandatory = $true)]
        [hashtable]$Configuration,
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [string]$DefaultValue = ''
    )

    if (-not [string]::IsNullOrWhiteSpace($CommandValue)) {
        return $CommandValue.Trim()
    }

    if ($Configuration.ContainsKey($Name) -and $null -ne $Configuration[$Name]) {
        $configuredValue = [string]$Configuration[$Name]
        if (-not [string]::IsNullOrWhiteSpace($configuredValue)) {
            return $configuredValue.Trim()
        }
    }

    return $DefaultValue
}

function Read-RequiredSetting {
    param(
        [AllowNull()]
        [string]$Value,
        [Parameter(Mandatory = $true)]
        [string]$Prompt,
        [switch]$NonInteractiveMode
    )

    if (-not [string]::IsNullOrWhiteSpace($Value)) {
        return $Value.Trim()
    }

    if ($NonInteractiveMode) {
        throw "Missing required setting: $Prompt"
    }

    do {
        $enteredValue = Read-Host -Prompt $Prompt
    } while ([string]::IsNullOrWhiteSpace($enteredValue))

    return $enteredValue.Trim()
}

function Get-WifiState {
    $adapter = Get-NetAdapter -Name $script:InterfaceAliasValue -ErrorAction SilentlyContinue
    $ssid = ''

    # netsh reports the actual SSID; the connection profile name can be renamed separately.
    if ($null -ne $adapter) {
        $netshOutput = @(& $script:NetshPath @('wlan', 'show', 'interfaces') 2>&1)
        $netshExitCode = $LASTEXITCODE

        if ($netshExitCode -eq 0) {
            foreach ($line in $netshOutput) {
                $lineText = [string]$line
                if ($lineText -match '^\s*SSID\s*:\s*(.+?)\s*$') {
                    $ssid = $Matches[1].Trim()
                    break
                }
            }
        }
    }

    if ([string]::IsNullOrWhiteSpace($ssid) -and $null -ne $adapter) {
        $connectionProfile = Get-NetConnectionProfile -InterfaceAlias $script:InterfaceAliasValue -ErrorAction SilentlyContinue
        if ($null -ne $connectionProfile) {
            $ssid = [string]$connectionProfile.Name
        }
    }

    $ipv4Address = ''
    $defaultGateway = ''
    $ipConfiguration = Get-NetIPConfiguration -InterfaceAlias $script:InterfaceAliasValue -ErrorAction SilentlyContinue
    if ($null -ne $ipConfiguration) {
        $ipv4Addresses = @(
            $ipConfiguration |
                ForEach-Object { $_.IPv4Address } |
                ForEach-Object { $_.IPAddress } |
                Where-Object { $_ -and $_ -notlike '169.254.*' }
        )
        if ($ipv4Addresses.Count -gt 0) {
            $ipv4Address = [string]$ipv4Addresses[0]
        }

        $gateways = @(
            $ipConfiguration |
                ForEach-Object { $_.IPv4DefaultGateway } |
                ForEach-Object { $_.NextHop } |
                Where-Object { $_ }
        )
        if ($gateways.Count -gt 0) {
            $defaultGateway = [string]$gateways[0]
        }
    }

    [pscustomobject]@{
        Ssid            = $ssid
        AdapterStatus   = if ($null -ne $adapter) { [string]$adapter.Status } else { 'NotFound' }
        IsUp            = ($null -ne $adapter -and [string]$adapter.Status -eq 'Up')
        IPv4Address     = $ipv4Address
        DefaultGateway  = $defaultGateway
    }
}

function Write-WifiState {
    param(
        [Parameter(Mandatory = $true)]
        [psobject]$State,
        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    Write-Log (
        '{0}: SSID="{1}", adapter={2}, IPv4={3}, gateway={4}' -f
        $Label,
        $State.Ssid,
        $State.AdapterStatus,
        $State.IPv4Address,
        $State.DefaultGateway
    )
}

function Assert-WifiInterface {
    $adapter = Get-NetAdapter -Name $script:InterfaceAliasValue -ErrorAction SilentlyContinue
    if ($null -eq $adapter) {
        throw "Wi-Fi interface '$script:InterfaceAliasValue' was not found. Use -InterfaceAlias with the name shown by Get-NetAdapter."
    }
}

function Assert-SavedWifiProfile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Ssid
    )

    $nativeArguments = @('wlan', 'show', 'profile', "name=$Ssid")
    $output = @(& $script:NetshPath @nativeArguments 2>&1)
    $exitCode = $LASTEXITCODE

    if ($exitCode -ne 0) {
        $details = ($output | ForEach-Object { [string]$_ }) -join ' '
        throw "Saved Wi-Fi profile '$Ssid' was not found or could not be read. $details"
    }
}

function Wait-ForWifi {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Ssid,
        [Parameter(Mandatory = $true)]
        [int]$TimeoutSeconds
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastObservedSsid = ''

    while ((Get-Date) -lt $deadline) {
        $state = Get-WifiState

        if ($state.Ssid -ne $lastObservedSsid) {
            if ([string]::IsNullOrWhiteSpace($state.Ssid)) {
                Write-Log 'Wi-Fi is not connected yet.'
            }
            else {
                Write-Log ("Observed SSID '{0}'. Waiting for '{1}'." -f $state.Ssid, $Ssid)
            }
            $lastObservedSsid = $state.Ssid
        }

        if ($state.IsUp -and $state.Ssid -eq $Ssid) {
            return $state
        }

        $remainingMilliseconds = [int][Math]::Ceiling(($deadline - (Get-Date)).TotalMilliseconds)
        if ($remainingMilliseconds -le 0) {
            break
        }

        Start-Sleep -Milliseconds ([Math]::Min(2000, $remainingMilliseconds))
    }

    $finalState = Get-WifiState
    throw (
        "Timed out waiting for SSID '{0}'. Current SSID is '{1}' and adapter status is '{2}'." -f
        $Ssid,
        $finalState.Ssid,
        $finalState.AdapterStatus
    )
}

function Connect-WifiProfile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Ssid,
        [Parameter(Mandatory = $true)]
        [int]$TimeoutSeconds
    )

    Assert-SavedWifiProfile -Ssid $Ssid
    Write-Log ("Requesting connection to saved Wi-Fi profile '{0}'." -f $Ssid)

    $nativeArguments = @(
        'wlan',
        'connect',
        "name=$Ssid",
        "interface=$script:InterfaceAliasValue"
    )
    $output = @(& $script:NetshPath @nativeArguments 2>&1)
    $exitCode = $LASTEXITCODE

    if ($exitCode -ne 0) {
        $details = ($output | ForEach-Object { [string]$_ }) -join ' '
        throw "Could not request connection to Wi-Fi profile '$Ssid'. $details"
    }

    $state = Wait-ForWifi -Ssid $Ssid -TimeoutSeconds $TimeoutSeconds
    Write-WifiState -State $state -Label 'Connected'
    return $state
}

function Test-CompanyEndpoint {
    param(
        [Parameter(Mandatory = $true)]
        [uri]$Url,
        [string]$RequiredText,
        [Parameter(Mandatory = $true)]
        [int]$TimeoutSeconds
    )

    $handler = $null
    $client = $null
    $response = $null
    $statusCode = 0
    $detail = ''
    $passed = $false

    try {
        $handler = [System.Net.Http.HttpClientHandler]::new()
        $handler.AllowAutoRedirect = $true
        $handler.MaxAutomaticRedirections = 5
        $handler.UseProxy = $true

        $client = [System.Net.Http.HttpClient]::new($handler)
        $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
        $client.DefaultRequestHeaders.UserAgent.ParseAdd('WiFi-Zscaler-Switcher/1.0')

        $response = $client.GetAsync(
            $Url.AbsoluteUri,
            [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead
        ).GetAwaiter().GetResult()

        $statusCode = [int]$response.StatusCode
        $reason = [string]$response.ReasonPhrase
        $passed = (($statusCode -ge 200 -and $statusCode -lt 400) -or $statusCode -eq 401 -or $statusCode -eq 403)
        $detail = 'HTTP {0} {1}' -f $statusCode, $reason

        if ($passed -and -not [string]::IsNullOrWhiteSpace($RequiredText)) {
            $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            if ($body.IndexOf($RequiredText, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
                $passed = $false
                $detail = 'HTTP response did not contain the configured expected text.'
            }
        }
    }
    catch {
        $exception = $_.Exception
        while ($null -ne $exception.InnerException) {
            $exception = $exception.InnerException
        }
        $detail = $exception.Message
        $passed = $false
    }
    finally {
        if ($null -ne $response) {
            $response.Dispose()
        }
        if ($null -ne $client) {
            $client.Dispose()
        }
        if ($null -ne $handler) {
            $handler.Dispose()
        }
    }

    [pscustomobject]@{
        Passed     = $passed
        StatusCode = $statusCode
        Detail     = $detail
    }
}

function Wait-ForCompanyEndpoint {
    param(
        [Parameter(Mandatory = $true)]
        [uri]$Url,
        [string]$RequiredText,
        [Parameter(Mandatory = $true)]
        [int]$TimeoutSeconds
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $attempt = 0
    $lastResult = $null

    do {
        $attempt++
        $remainingSeconds = [int][Math]::Ceiling(($deadline - (Get-Date)).TotalSeconds)
        $attemptTimeoutSeconds = [Math]::Min(15, [Math]::Max(1, $remainingSeconds))
        $lastResult = Test-CompanyEndpoint -Url $Url -RequiredText $RequiredText -TimeoutSeconds $attemptTimeoutSeconds
        if ($lastResult.Passed) {
            Write-Log ("Company endpoint test passed on attempt {0}: {1}" -f $attempt, $lastResult.Detail)
            return $lastResult
        }

        Write-Log ("Company endpoint attempt {0} failed: {1}" -f $attempt, $lastResult.Detail) 'WARN'
        if ((Get-Date) -ge $deadline) {
            break
        }

        $remainingMilliseconds = [int][Math]::Ceiling(($deadline - (Get-Date)).TotalMilliseconds)
        if ($remainingMilliseconds -le 0) {
            break
        }

        Start-Sleep -Milliseconds ([Math]::Min(3000, $remainingMilliseconds))
    } while ((Get-Date) -lt $deadline)

    return $lastResult
}

function Request-ManualConfirmation {
    param(
        [Parameter(Mandatory = $true)]
        [uri]$Url
    )

    if ($NonInteractive) {
        throw '-ManualConfirmation cannot be used with -NonInteractive.'
    }

    Write-Log ("Opening '{0}' in the default browser for manual confirmation." -f $Url.AbsoluteUri)
    Start-Process -FilePath $Url.AbsoluteUri | Out-Null
    $answer = Read-Host -Prompt 'After confirming the company resource works, enter Y to continue'
    if ($answer -notmatch '^(?i:y|yes)$') {
        throw 'Manual confirmation was not accepted.'
    }
}

$defaultConfigPath = Join-Path -Path $PSScriptRoot -ChildPath 'wifi-switcher.config.psd1'
$resolvedConfigPath = if ([string]::IsNullOrWhiteSpace($ConfigPath)) { $defaultConfigPath } else { $ConfigPath }
$configuration = Read-Configuration -Path $resolvedConfigPath

$directSsidValue = Get-ConfiguredText -CommandValue $DirectSsid -Configuration $configuration -Name 'DirectSsid'
$bypassSsidValue = Get-ConfiguredText -CommandValue $BypassSsid -Configuration $configuration -Name 'BypassSsid'
$companyTestUrlValue = Get-ConfiguredText -CommandValue $CompanyTestUrl -Configuration $configuration -Name 'CompanyTestUrl'
$expectedTextValue = Get-ConfiguredText -CommandValue $ExpectedText -Configuration $configuration -Name 'ExpectedText'
$interfaceAliasValue = Get-ConfiguredText -CommandValue $InterfaceAlias -Configuration $configuration -Name 'InterfaceAlias' -DefaultValue 'Wi-Fi'

$script:InterfaceAliasValue = $interfaceAliasValue

$directSsidValue = Read-RequiredSetting -Value $directSsidValue -Prompt 'SSID for the direct/main-router Wi-Fi' -NonInteractiveMode:$NonInteractive
$companyTestUrlValue = Read-RequiredSetting -Value $companyTestUrlValue -Prompt 'Company URL that is reachable only after Zscaler is connected' -NonInteractiveMode:$NonInteractive

if (-not [string]::IsNullOrWhiteSpace($bypassSsidValue) -and $directSsidValue -eq $bypassSsidValue) {
    throw 'DirectSsid and BypassSsid must be different saved Wi-Fi profiles.'
}

try {
    $companyUri = [uri]$companyTestUrlValue
}
catch {
    throw "CompanyTestUrl is not a valid URL: $companyTestUrlValue"
}

if ($companyUri.Scheme -notin @('http', 'https') -or [string]::IsNullOrWhiteSpace($companyUri.Host)) {
    throw 'CompanyTestUrl must be an HTTP or HTTPS URL with a host name.'
}

if ($ConnectTimeoutSeconds -lt 5 -or $WarmupSeconds -lt 0 -or $MaxVpnWaitSeconds -lt 5 -or $MaxVpnWaitSeconds -gt 180 -or $PostReturnTestTimeoutSeconds -lt 5) {
    throw 'Timeout values are outside the supported range.'
}

$originalState = $null
$returnSsidValue = $bypassSsidValue
$workflowFailure = $null
$returnFailure = $null
$directSuccess = $false
$postReturnResult = $null

try {
    Assert-WifiInterface
    $originalState = Get-WifiState
    Write-WifiState -State $originalState -Label 'Initial state'

    if ([string]::IsNullOrWhiteSpace($returnSsidValue)) {
        $returnSsidValue = $originalState.Ssid
    }

    if ([string]::IsNullOrWhiteSpace($returnSsidValue)) {
        throw 'The starting Wi-Fi SSID could not be detected. Set BypassSsid in the configuration file and run again.'
    }

    if ($returnSsidValue -eq $directSsidValue) {
        throw 'The return Wi-Fi profile must be different from DirectSsid. Start on the bypass Wi-Fi or set BypassSsid explicitly.'
    }

    if ($originalState.Ssid -ne $returnSsidValue) {
        Write-Log ("Initial SSID is not the configured return SSID. The script will return to '{0}'." -f $returnSsidValue) 'WARN'
    }

    Assert-SavedWifiProfile -Ssid $directSsidValue
    Assert-SavedWifiProfile -Ssid $returnSsidValue

    # The direct-network phase has one hard deadline, including Wi-Fi association,
    # Zscaler warm-up, and the company endpoint check.
    $directPhaseDeadline = (Get-Date).AddSeconds($MaxVpnWaitSeconds)
    $connectRemainingSeconds = [int][Math]::Ceiling(($directPhaseDeadline - (Get-Date)).TotalSeconds)
    $connectTimeout = [Math]::Min($ConnectTimeoutSeconds, [Math]::Max(1, $connectRemainingSeconds))
    Connect-WifiProfile -Ssid $directSsidValue -TimeoutSeconds $connectTimeout | Out-Null

    if ($WarmupSeconds -gt 0) {
        $warmupRemainingSeconds = [int][Math]::Ceiling(($directPhaseDeadline - (Get-Date)).TotalSeconds)
        if ($warmupRemainingSeconds -le 0) {
            throw "The {0}-second VPN wait limit was reached before Zscaler warm-up completed." -f $MaxVpnWaitSeconds
        }

        $warmupSeconds = [Math]::Min($WarmupSeconds, $warmupRemainingSeconds)
        Write-Log ("Waiting {0} seconds for the Zscaler client to establish its tunnel." -f $warmupSeconds)
        Start-Sleep -Seconds $warmupSeconds
    }

    if ($ManualConfirmation) {
        Request-ManualConfirmation -Url $companyUri
    }

    Write-Log ("Testing company endpoint '{0}'." -f $companyUri.AbsoluteUri)
    $testRemainingSeconds = [int][Math]::Ceiling(($directPhaseDeadline - (Get-Date)).TotalSeconds)
    if ($testRemainingSeconds -le 0) {
        throw "The {0}-second VPN wait limit was reached before the company endpoint test." -f $MaxVpnWaitSeconds
    }

    $directResult = Wait-ForCompanyEndpoint -Url $companyUri -RequiredText $expectedTextValue -TimeoutSeconds $testRemainingSeconds
    if (-not $directResult.Passed) {
        throw "Company endpoint test failed after connecting to the direct Wi-Fi: $($directResult.Detail)"
    }

    $directSuccess = $true
    Write-Log 'Direct Wi-Fi and company-resource test succeeded.'
}
catch {
    $workflowFailure = $_.Exception
    Write-Log $workflowFailure.Message 'ERROR'
}
finally {
    try {
        if ([string]::IsNullOrWhiteSpace($returnSsidValue)) {
            throw 'No return Wi-Fi profile is available.'
        }

        Write-Log ("Returning to bypass-router Wi-Fi '{0}'." -f $returnSsidValue)
        Connect-WifiProfile -Ssid $returnSsidValue -TimeoutSeconds $ConnectTimeoutSeconds | Out-Null

        if ($directSuccess -and -not $NoPostReturnTest) {
            Write-Log 'Testing whether the company endpoint remains reachable after returning to the bypass Wi-Fi.'
            $postReturnResult = Wait-ForCompanyEndpoint -Url $companyUri -RequiredText $expectedTextValue -TimeoutSeconds $PostReturnTestTimeoutSeconds
        }
    }
    catch {
        $returnFailure = $_.Exception
        Write-Log $returnFailure.Message 'ERROR'
    }
}

if ($null -ne $returnFailure) {
    Write-Log 'The script could not confirm that it returned to the bypass Wi-Fi.' 'ERROR'
    if ($null -ne $workflowFailure) {
        Write-Log ("The earlier operation also failed: {0}" -f $workflowFailure.Message) 'ERROR'
    }
    exit 2
}

if ($null -ne $workflowFailure) {
    Write-Log 'The bypass Wi-Fi connection was restored, but the direct Wi-Fi/Zscaler test failed.' 'ERROR'
    exit 1
}

if ($directSuccess -and $null -ne $postReturnResult -and -not $postReturnResult.Passed) {
    Write-Log ("Returned to bypass Wi-Fi, but the post-return company endpoint test failed: {0}" -f $postReturnResult.Detail) 'WARN'
    Write-Log 'The computer was left on the bypass Wi-Fi as requested.' 'WARN'
    exit 3
}

Write-Log 'Completed successfully. The computer is on the bypass Wi-Fi.'
exit 0
