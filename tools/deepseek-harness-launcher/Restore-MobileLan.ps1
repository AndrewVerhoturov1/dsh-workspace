# Executed only by the fixed SYSTEM scheduled task.
# No parameters, environment configuration, dot-sourcing, or caller-supplied paths.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$MobileAddress = '192.168.0.5'
$MobilePort = 4173
$ProxyTarget = '127.0.0.1'
$TaskFirewallName = 'DSH-Mobile-LAN-WiFi-4173'
$NetshExe = 'C:\Windows\System32\netsh.exe'

function Test-MobileLanHttp([string]$Url, [int]$ExpectedStatus, [string]$ExpectedLocation = '') {
    $request = [System.Net.HttpWebRequest]::Create($Url)
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Timeout = 2500
    $response = $null
    try {
        try {
            $response = $request.GetResponse()
        } catch [System.Net.WebException] {
            if ($null -eq $_.Exception.Response) { return $false }
            $response = $_.Exception.Response
        }
        if ([int]$response.StatusCode -ne $ExpectedStatus) { return $false }
        if ($ExpectedLocation -and [string]$response.Headers['Location'] -ne $ExpectedLocation) { return $false }
        return $true
    } catch {
        return $false
    } finally {
        if ($null -ne $response) { $response.Dispose() }
    }
}

function Get-MobileLanListeners {
    return @(Get-NetTCPConnection -State Listen -LocalPort $MobilePort -ErrorAction Stop)
}

function Get-IpHelperPid {
    # Windows portproxy can be owned by the IP Helper svchost process rather
    # than PID 4. A foreign listener must never be treated as our proxy.
    $services = @(Get-CimInstance -ClassName Win32_Service -Filter "Name='iphlpsvc'" -ErrorAction Stop)
    if ($services.Count -ne 1 -or [string]$services[0].State -ne 'Running' -or
        [int]$services[0].ProcessId -le 0) {
        throw 'IPHLPSVC_NOT_RUNNING'
    }
    return [int]$services[0].ProcessId
}

function Get-MobilePortproxyRows {
    $rows = @(& $NetshExe interface portproxy show v4tov4)
    if ($LASTEXITCODE -ne 0) { throw 'PORTPROXY_INSPECTION_FAILED' }
    return $rows
}

function Refresh-ExactPortproxy {
    & $NetshExe interface portproxy delete v4tov4 listenaddress=192.168.0.5 listenport=4173 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'EXACT_PORTPROXY_DELETE_FAILED' }
    & $NetshExe interface portproxy add v4tov4 listenaddress=192.168.0.5 listenport=4173 connectaddress=127.0.0.1 connectport=4173 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'EXACT_PORTPROXY_ADD_FAILED' }
}

function Assert-MobileLanConfiguration {
    $ipHelperPid = Get-IpHelperPid

    $ips = @(Get-NetIPAddress -AddressFamily IPv4 -IPAddress $MobileAddress -ErrorAction Stop)
    if ($ips.Count -ne 1 -or $ips[0].PrefixLength -ne 24 -or [string]$ips[0].AddressState -ne 'Preferred') {
        throw 'PHYSICAL_WIFI_IP_MISMATCH'
    }
    $physical = @(Get-NetAdapter -Physical -ErrorAction Stop | Where-Object {
        $_.InterfaceIndex -eq $ips[0].InterfaceIndex -and
        [string]$_.Status -eq 'Up' -and
        ($_.InterfaceDescription -match '(?i)wireless|wi-fi|802\.11' -or [string]$_.MediaType -eq 'Native 802.11')
    })
    if ($physical.Count -ne 1) { throw 'PHYSICAL_WIFI_ADAPTER_MISMATCH' }
    $profiles = @(Get-NetConnectionProfile -InterfaceIndex $ips[0].InterfaceIndex -ErrorAction Stop)
    if ($profiles.Count -ne 1 -or [string]$profiles[0].NetworkCategory -ne 'Public') {
        throw 'WIFI_NETWORK_PROFILE_MISMATCH'
    }

    $rows = @(Get-MobilePortproxyRows)
    $matching = @(
        foreach ($row in $rows) {
            if ([string]$row -match '^\s*(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s*$') {
                if ($Matches[1] -eq $MobileAddress -and [int]$Matches[2] -eq $MobilePort) {
                    [pscustomobject]@{ Target = $Matches[3]; Port = [int]$Matches[4] }
                }
            }
        }
    )
    if ($matching.Count -ne 1 -or $matching[0].Target -ne $ProxyTarget -or $matching[0].Port -ne $MobilePort) {
        throw 'PORTPROXY_EXACT_ROW_MISMATCH'
    }

    $rules = @(Get-NetFirewallRule -Name $TaskFirewallName -ErrorAction Stop)
    if ($rules.Count -ne 1) { throw 'FIREWALL_RULE_MISMATCH' }
    $rule = $rules[0]
    $port = $rule | Get-NetFirewallPortFilter -ErrorAction Stop
    $address = $rule | Get-NetFirewallAddressFilter -ErrorAction Stop
    $interface = $rule | Get-NetFirewallInterfaceFilter -ErrorAction Stop
    $interfaceType = $rule | Get-NetFirewallInterfaceTypeFilter -ErrorAction Stop
    $app = $rule | Get-NetFirewallApplicationFilter -ErrorAction Stop
    $service = $rule | Get-NetFirewallServiceFilter -ErrorAction Stop
    $remote = @($address.RemoteAddress | Sort-Object)
    if ([string]$rule.Enabled -ne 'True' -or [string]$rule.Direction -ne 'Inbound' -or
        [string]$rule.Action -ne 'Allow' -or [string]$rule.Profile -ne 'Public' -or
        [string]$port.Protocol -ne 'TCP' -or [string]$port.LocalPort -ne '4173' -or
        [string]$port.RemotePort -ne 'Any' -or [string]$address.LocalAddress -ne $MobileAddress -or
        $remote.Count -ne 2 -or $remote[0] -ne '192.168.0.2' -or $remote[1] -ne '192.168.0.3' -or
        @($interface.InterfaceAlias).Count -ne 1 -or
        [string]$interface.InterfaceAlias -ne [string]$ips[0].InterfaceAlias -or
        [string]$interfaceType.InterfaceType -ne 'Any' -or
        [string]$app.Program -ne 'Any' -or [string]$service.Service -ne 'Any') {
        throw 'FIREWALL_RULE_MISMATCH'
    }

    $listeners = @(Get-MobileLanListeners)
    if (@($listeners | Where-Object { $_.LocalAddress -in @('0.0.0.0', '::') }).Count -gt 0) {
        throw 'WILDCARD_LISTENER_CONFLICT'
    }
    $lan = @($listeners | Where-Object { $_.LocalAddress -eq $MobileAddress })
    if ($lan.Count -gt 1 -or @($lan | Where-Object { $_.OwningProcess -notin @(4, $ipHelperPid) }).Count -gt 0) {
        throw 'LAN_LISTENER_CONFLICT'
    }
    if (-not (Test-MobileLanHttp 'http://127.0.0.1:4173/' 200) -or
        -not (Test-MobileLanHttp 'http://127.0.0.1:4173/mobile' 302 '/?mobile=1')) {
        throw 'DSH_WEB_OR_MOBILE_NOT_READY'
    }
    return ($lan.Count -eq 1)
}

function Invoke-MobileLanRepair {
    $listening = Assert-MobileLanConfiguration
    if ($listening) {
        if (-not (Test-MobileLanHttp 'http://192.168.0.5:4173/?mobile=1' 200)) {
            throw 'LAN_LISTENER_UNRESPONSIVE'
        }
        Write-Output 'MOBILE_LAN_HEALTHY'
        return
    }

    # Only the existing exact v4tov4 row may be refreshed, once per task run.
    Refresh-ExactPortproxy

    $lan = @(Get-MobileLanListeners | Where-Object { $_.LocalAddress -eq $MobileAddress })
    if ($lan.Count -ne 1 -or $lan[0].OwningProcess -notin @(4, (Get-IpHelperPid)) -or
        -not (Test-MobileLanHttp 'http://192.168.0.5:4173/?mobile=1' 200)) {
        throw 'MOBILE_LAN_NOT_READY_AFTER_REFRESH'
    }
    Write-Output 'MOBILE_LAN_RESTORED'
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        Invoke-MobileLanRepair
        exit 0
    } catch {
        [Console]::Error.WriteLine('MOBILE_LAN_NOT_READY: ' + $_.Exception.Message)
        exit 1
    }
}
