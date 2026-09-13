# Minimal static file server for Blunder Atlas (no Node/Python required).
# Listens on all network interfaces, so it's reachable both at
# http://localhost:<port> on this PC and at http://<this-PC's-LAN-IP>:<port>
# from another device on the same Wi-Fi (e.g. a phone).
#
# Usage: powershell -ExecutionPolicy Bypass -File server.ps1 [-Port 8843]
#
# Uses a raw TCP socket (not System.Net.HttpListener) so it can bind to all
# interfaces without needing Administrator rights or a URL ACL reservation.
# Windows Firewall may still prompt to allow it on first run — that's a
# normal, one-time OS prompt you'll need to click "Allow" on yourself.

param(
  [int]$Port = 8843
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'application/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.wasm' = 'application/wasm'
  '.png'  = 'image/png'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
try {
  $listener.Start()
} catch {
  Write-Host "Failed to start server on port $Port. Try a different -Port." -ForegroundColor Red
  exit 1
}

$lanIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  Select-Object -First 1 -ExpandProperty IPAddress)

Write-Host "Blunder Atlas is running:" -ForegroundColor Green
Write-Host "  On this PC:        http://localhost:$Port/" -ForegroundColor Green
if ($lanIp) {
  Write-Host "  On your network:   http://${lanIp}:$Port/  (use this on your phone, same Wi-Fi)" -ForegroundColor Green
}
Write-Host "Press Ctrl+C to stop." -ForegroundColor DarkGray

function Send-Response {
  param($Stream, [int]$StatusCode, [string]$StatusText, [string]$ContentType, [byte[]]$Body, [string]$CacheControl)
  $headers = "HTTP/1.1 $StatusCode $StatusText`r`n" +
             "Content-Type: $ContentType`r`n" +
             "Content-Length: $($Body.Length)`r`n" +
             $(if ($CacheControl) { "Cache-Control: $CacheControl`r`n" } else { "" }) +
             "Connection: close`r`n`r`n"
  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headers)
  $Stream.Write($headerBytes, 0, $headerBytes.Length)
  if ($Body.Length -gt 0) { $Stream.Write($Body, 0, $Body.Length) }
}

while ($true) {
  try {
    $client = $listener.AcceptTcpClient()
  } catch {
    break
  }
  try {
    $client.NoDelay = $true
    $stream = $client.GetStream()
    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII)
    $requestLine = $reader.ReadLine()
    if ($requestLine) {
      while (($line = $reader.ReadLine()) -and $line -ne '') { } # discard headers

      $parts = $requestLine -split ' '
      $rawPath = if ($parts.Length -ge 2) { $parts[1] } else { '/' }
      $path = ($rawPath -split '\?')[0]
      if ($path -eq '/') { $path = '/index.html' }
      $decodedPath = [System.Uri]::UnescapeDataString($path)
      $filePath = Join-Path $root ($decodedPath.TrimStart('/') -replace '/', [System.IO.Path]::DirectorySeparatorChar)

      $fullRoot = [System.IO.Path]::GetFullPath($root)
      $fullFile = try { [System.IO.Path]::GetFullPath($filePath) } catch { $null }

      if ($fullFile -and $fullFile.StartsWith($fullRoot) -and (Test-Path $fullFile -PathType Leaf)) {
        $ext = [System.IO.Path]::GetExtension($fullFile).ToLower()
        $contentType = $mime[$ext]
        if (-not $contentType) { $contentType = 'application/octet-stream' }
        $bytes = [System.IO.File]::ReadAllBytes($fullFile)
        # Vendored binaries (engine wasm, piece SVGs) never change here, so let
        # the browser cache them; everything else is actively edited, so force
        # revalidation to avoid ever serving a stale mix of old/new files.
        $cache = if ($ext -eq '.wasm' -or $fullFile -like '*\lib\pieces\*') {
          'public, max-age=31536000, immutable'
        } else {
          'no-cache, no-store, must-revalidate'
        }
        Send-Response -Stream $stream -StatusCode 200 -StatusText 'OK' -ContentType $contentType -Body $bytes -CacheControl $cache
      } else {
        $msg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $decodedPath")
        Send-Response -Stream $stream -StatusCode 404 -StatusText 'Not Found' -ContentType 'text/plain' -Body $msg -CacheControl $null
      }
    }
  } catch {
  } finally {
    $client.Close()
  }
}

$listener.Stop()
