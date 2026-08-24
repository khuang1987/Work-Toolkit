$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework

$themeKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'

function Get-IsDark {
    try { return ((Get-ItemPropertyValue -Path $themeKey -Name AppsUseLightTheme -ErrorAction Stop) -eq 0) }
    catch { return $false }
}

function Set-Theme([bool]$dark) {
    $value = [int](-not $dark)   # 1 = light, 0 = dark
    Set-ItemProperty -Path $themeKey -Name AppsUseLightTheme -Value $value
    Set-ItemProperty -Path $themeKey -Name SystemUsesLightTheme -Value $value
}

function Brush([string]$hex) {
    New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($hex))
}

$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Width="56" Height="56" WindowStyle="None" AllowsTransparency="True"
        Background="Transparent" ResizeMode="NoResize" Topmost="True"
        ShowInTaskbar="False" WindowStartupLocation="Manual" Title="深浅色切换">
  <Border x:Name="Btn" Margin="4" CornerRadius="24" Cursor="Hand" BorderThickness="1">
    <Border.Effect>
      <DropShadowEffect BlurRadius="14" ShadowDepth="0" Opacity="0.35" Color="Black"/>
    </Border.Effect>
    <Grid>
      <Path x:Name="Sun"
            Fill="#FFB300" Stroke="#FFB300" StrokeThickness="3"
            StrokeStartLineCap="Round" StrokeEndLineCap="Round" StrokeLineJoin="Round"
            Data="M24,16.5 A7.5,7.5 0 1,1 23.999,16.5 Z
                  M24,14 V10.5 M24,34 V37.5 M34,24 H37.5 M14,24 H10.5
                  M31.07,16.93 L33.55,14.45 M31.07,31.07 L33.55,33.55
                  M16.93,31.07 L14.45,33.55 M16.93,16.93 L14.45,14.45"/>
      <Path x:Name="Moon" Visibility="Collapsed" Fill="#D6DAE1"
            Data="M41,25.58 A18,18 0 1,1 22.42,7 14,14 0 0,0 41,25.58 Z"/>
      <Thumb x:Name="Drag" IsTabStop="False" Opacity="0">
        <Thumb.Template>
          <ControlTemplate><Border Background="Transparent"/></ControlTemplate>
        </Thumb.Template>
      </Thumb>
    </Grid>
  </Border>
</Window>
'@

$win = [System.Windows.Markup.XamlReader]::Parse($xaml)
$btn = $win.FindName('Btn')
$sun = $win.FindName('Sun')
$moon = $win.FindName('Moon')
$drag = $win.FindName('Drag')

$script:moved = $false

$drag.Add_DragDelta({
    param($s, $e)
    $script:moved = $true
    $win.Left += $e.HorizontalChange
    $win.Top += $e.VerticalChange
})

$drag.Add_DragCompleted({
    param($s, $e)
    if (-not $script:moved) {
        $dark = -not (Get-IsDark)
        Set-Theme $dark
        Update-UI $dark
    }
    $script:moved = $false
})

$btn.Add_MouseRightButtonUp({ $win.Close() })

function Update-UI([bool]$dark) {
    if ($dark) {
        $sun.Visibility = 'Collapsed'
        $moon.Visibility = 'Visible'
        $btn.Background = Brush('#202024')
        $btn.BorderBrush = Brush('#3A3A41')
    }
    else {
        $sun.Visibility = 'Visible'
        $moon.Visibility = 'Collapsed'
        $btn.Background = Brush('#FFFFFF')
        $btn.BorderBrush = Brush('#DDDDE3')
    }
}

$win.ToolTip = '左键点击切换深/浅色模式' + [char]10 + '按住拖动可移动' + [char]10 + '右键退出'

$win.Left = [System.Windows.SystemParameters]::PrimaryScreenWidth - 56 - 24
$win.Top = 24

Update-UI (Get-IsDark)
$null = $win.ShowDialog()
