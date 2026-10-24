//! Screenshot of a single window. The image stays in memory and is never
//! written to disk.

use std::io::Cursor;

use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CreateCompatibleBitmap, CreateCompatibleDC, DIB_RGB_COLORS,
    DeleteDC, DeleteObject, GetDC, GetDIBits, HALFTONE, ReleaseDC, SRCCOPY, SelectObject,
    SetBrushOrgEx, SetStretchBltMode, StretchBlt,
};
use windows::Win32::Storage::Xps::{PRINT_WINDOW_FLAGS, PrintWindow};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId, IsIconic, PW_RENDERFULLCONTENT,
};

/// Wider windows are scaled down. Saves time and quota, text stays readable.
const MAX_WIDTH: i32 = 1600;

/// The foreground window as a number (an HWND itself must not move between
/// threads). `None` if there is none or it belongs to malum itself.
pub fn foreground_window() -> Option<isize> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        (pid != std::process::id()).then_some(hwnd.0 as isize)
    }
}

/// Capture a window as PNG. Works even when the overlay is on top of it,
/// because the window draws itself into a bitmap.
pub fn capture_png(window: isize) -> Result<Vec<u8>, String> {
    let hwnd = HWND(window as *mut _);
    unsafe {
        if IsIconic(hwnd).as_bool() {
            return Err("window is minimized".into());
        }
        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).map_err(|e| e.to_string())?;
        let (width, height) = (rect.right - rect.left, rect.bottom - rect.top);
        if width <= 0 || height <= 0 {
            return Err("window has no size".into());
        }
        let (out_w, out_h) = if width > MAX_WIDTH {
            (MAX_WIDTH, (height as i64 * MAX_WIDTH as i64 / width as i64) as i32)
        } else {
            (width, height)
        };

        let screen = GetDC(None);
        let full_dc = CreateCompatibleDC(Some(screen));
        let full_bmp = CreateCompatibleBitmap(screen, width, height);
        let old_full = SelectObject(full_dc, full_bmp.into());
        // PW_RENDERFULLCONTENT is needed for browsers and other GPU windows (e.g. a PDF in Edge).
        let printed = PrintWindow(hwnd, full_dc, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)).as_bool();

        let out_dc = CreateCompatibleDC(Some(screen));
        let out_bmp = CreateCompatibleBitmap(screen, out_w, out_h);
        let old_out = SelectObject(out_dc, out_bmp.into());
        SetStretchBltMode(out_dc, HALFTONE);
        let _ = SetBrushOrgEx(out_dc, 0, 0, None);
        let stretched =
            StretchBlt(out_dc, 0, 0, out_w, out_h, Some(full_dc), 0, 0, width, height, SRCCOPY).as_bool();
        // GetDIBits requires the bitmap to no longer be selected into a DC.
        SelectObject(out_dc, old_out);

        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: out_w,
                biHeight: -out_h, // negative = rows from top to bottom
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bgra = vec![0u8; (out_w * out_h * 4) as usize];
        let lines = GetDIBits(
            out_dc,
            out_bmp,
            0,
            out_h as u32,
            Some(bgra.as_mut_ptr().cast()),
            &mut info,
            DIB_RGB_COLORS,
        );

        SelectObject(full_dc, old_full);
        let _ = DeleteObject(full_bmp.into());
        let _ = DeleteObject(out_bmp.into());
        let _ = DeleteDC(full_dc);
        let _ = DeleteDC(out_dc);
        ReleaseDC(None, screen);

        if !printed || !stretched || lines == 0 {
            return Err("window could not be captured".into());
        }
        encode_png(&bgra, out_w as u32, out_h as u32)
    }
}

fn encode_png(bgra: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let rgb: Vec<u8> = bgra.chunks_exact(4).flat_map(|p| [p[2], p[1], p[0]]).collect();
    let mut out = Cursor::new(Vec::new());
    let mut encoder = png::Encoder::new(&mut out, width, height);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    writer.write_image_data(&rgb).map_err(|e| e.to_string())?;
    writer.finish().map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}
