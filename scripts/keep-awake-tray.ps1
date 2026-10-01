# System-tray controller for JobHuntAssist keep-awake.
# Green dot = holding the system awake, grey dot = paused (normal sleep).
# Right-click for modes; double-click toggles awake/paused. Auto-releases at $Until.
param(
    [string]$Until = "17:00"
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Single instance only
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\JobHuntAssistKeepAwake', [ref]$created)
if (-not $created) { exit }

$power = Add-Type -PassThru -Namespace KeepAwake -Name PowerUtil -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@

$ES_CONTINUOUS      = [uint32]"0x80000000"
$ES_SYSTEM_REQUIRED = [uint32]"0x00000001"

function New-DotIcon([System.Drawing.Color]$color) {
    $bmp = New-Object System.Drawing.Bitmap 16, 16
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $brush = New-Object System.Drawing.SolidBrush $color
    $g.FillEllipse($brush, 1, 1, 13, 13)
    $brush.Dispose(); $g.Dispose()
    $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
    $bmp.Dispose()
    return $icon
}

$iconAwake  = New-DotIcon ([System.Drawing.Color]::FromArgb(46, 204, 113))
$iconPaused = New-DotIcon ([System.Drawing.Color]::FromArgb(150, 150, 150))

$script:mode = 'paused'
$script:endTime = Get-Date $Until

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$script:miUntil   = $menu.Items.Add("Keep awake until $Until")
$script:miForever = $menu.Items.Add('Keep awake until I stop it')
$script:miPause   = $menu.Items.Add('Pause - allow normal sleep')
[void]$menu.Items.Add('-')
$miExit = $menu.Items.Add('Exit')
$tray.ContextMenuStrip = $menu

function Set-Mode([string]$mode) {
    $script:mode = $mode
    switch ($mode) {
        'until' {
            # "until 17:00" means today's 17:00, or tomorrow's if that already passed
            $e = Get-Date $Until
            if ((Get-Date) -ge $e) { $e = $e.AddDays(1) }
            $script:endTime = $e
            [void]$power::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)
            $text = "awake until $($e.ToString('HH:mm'))"
            $tray.Icon = $iconAwake
        }
        'forever' {
            [void]$power::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)
            $text = 'awake until stopped'
            $tray.Icon = $iconAwake
        }
        'paused' {
            [void]$power::SetThreadExecutionState($ES_CONTINUOUS)
            $text = 'paused (normal sleep)'
            $tray.Icon = $iconPaused
        }
    }
    $tray.Text = "JobHuntAssist: $text"
    $script:miUntil.Checked   = ($mode -eq 'until')
    $script:miForever.Checked = ($mode -eq 'forever')
    $script:miPause.Checked   = ($mode -eq 'paused')
    $tray.BalloonTipTitle = 'JobHuntAssist keep-awake'
    $tray.BalloonTipText  = "Now: $text"
    $tray.ShowBalloonTip(2000)
}

$script:miUntil.add_Click({ Set-Mode 'until' })
$script:miForever.add_Click({ Set-Mode 'forever' })
$script:miPause.add_Click({ Set-Mode 'paused' })
$miExit.add_Click({
    [void]$power::SetThreadExecutionState($ES_CONTINUOUS)
    $tray.Visible = $false
    $tray.Dispose()
    [System.Windows.Forms.Application]::Exit()
})

# Double-click the dot to toggle
$tray.add_DoubleClick({
    if ($script:mode -eq 'paused') { Set-Mode 'until' } else { Set-Mode 'paused' }
})

# Auto-release when the end time passes
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 30000
$timer.add_Tick({
    if ($script:mode -eq 'until' -and (Get-Date) -ge $script:endTime) {
        Set-Mode 'paused'
    }
})
$timer.Start()

Set-Mode 'until'
[System.Windows.Forms.Application]::Run()
