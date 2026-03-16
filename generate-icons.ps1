[CmdletBinding()]
param(
  [string]$OutputDir = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $OutputDir) {
  $scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
  $OutputDir = Join-Path $scriptRoot "assets"
}

Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $OutputDir)) {
  New-Item -ItemType Directory -Path $OutputDir | Out-Null
}

$sizes = @(16, 32, 48, 128)
$backgroundColor = [System.Drawing.ColorTranslator]::FromHtml("#1D6FEF")
$foregroundColor = [System.Drawing.Color]::White

foreach ($size in $sizes) {
  $bitmap = New-Object System.Drawing.Bitmap($size, $size)
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.Clear([System.Drawing.Color]::Transparent)

      $cornerRadius = [Math]::Max(2, [int]([Math]::Round($size * 0.22)))
      $rectWidth = [single]($size - 1)
      $rectHeight = [single]($size - 1)
      $rect = New-Object System.Drawing.RectangleF([single]0, [single]0, $rectWidth, $rectHeight)
      $backgroundPath = New-Object System.Drawing.Drawing2D.GraphicsPath
      try {
        $diameter = [single]($cornerRadius * 2)
        $rightArcX = [single]($rect.Right - $diameter)
        $bottomArcY = [single]($rect.Bottom - $diameter)
        $backgroundPath.AddArc($rect.X, $rect.Y, $diameter, $diameter, 180, 90)
        $backgroundPath.AddArc($rightArcX, $rect.Y, $diameter, $diameter, 270, 90)
        $backgroundPath.AddArc($rightArcX, $bottomArcY, $diameter, $diameter, 0, 90)
        $backgroundPath.AddArc($rect.X, $bottomArcY, $diameter, $diameter, 90, 90)
        $backgroundPath.CloseFigure()

        $backgroundBrush = New-Object System.Drawing.SolidBrush($backgroundColor)
        try {
          $graphics.FillPath($backgroundBrush, $backgroundPath)
        }
        finally {
          $backgroundBrush.Dispose()
        }
      }
      finally {
        $backgroundPath.Dispose()
      }

      $lineWidth = [Math]::Max(2, [single]($size * 0.125))
      $pen = New-Object System.Drawing.Pen($foregroundColor, $lineWidth)
      try {
        $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

        $points = @(
          (New-Object System.Drawing.PointF([single]($size * 0.24), [single]($size * 0.76))),
          (New-Object System.Drawing.PointF([single]($size * 0.24), [single]($size * 0.26))),
          (New-Object System.Drawing.PointF([single]($size * 0.50), [single]($size * 0.58))),
          (New-Object System.Drawing.PointF([single]($size * 0.76), [single]($size * 0.26))),
          (New-Object System.Drawing.PointF([single]($size * 0.76), [single]($size * 0.76)))
        )

        $graphics.DrawLines($pen, $points)
      }
      finally {
        $pen.Dispose()
      }
    }
    finally {
      $graphics.Dispose()
    }

    $outputPath = Join-Path $OutputDir ("icon-{0}.png" -f $size)
    $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  }
  finally {
    $bitmap.Dispose()
  }
}
