//! The macOS traffic lights. Their left inset comes from `trafficLightPosition` and Tauri puts it
//! back on every redraw, but it keeps whatever spacing the three buttons have. So the buttons are
//! drawn closer together here as the sidebar folds, a step at a time while the page animates it,
//! and the page is told their size so it can centre them in the folded sidebar.

/// Space between two neighbouring lights when the sidebar is folded.
#[cfg(target_os = "macos")]
const TIGHT_GAP: f64 = 4.0;

#[cfg(target_os = "macos")]
static NATURAL_STEP: std::sync::OnceLock<f64> = std::sync::OnceLock::new();

/// How the lights are laid out, in points: one button's width, the distance from one button to
/// the next as macOS draws them and when compact, and the group's width as it is now.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lights {
    button: f64,
    natural_step: f64,
    tight_step: f64,
    width: f64,
}

/// Spaces the lights `compact` of the way (0 to 1) from their natural spacing to the tight one.
/// `None` off macOS, or when the window has no lights.
#[tauri::command]
pub fn traffic_lights(window: tauri::WebviewWindow, compact: f64) -> Option<Lights> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSWindow, NSWindowButton};
        use objc2_foundation::NSPoint;

        // A command without `async` runs on the main thread, which is where AppKit wants this.
        let ptr = window.ns_window().ok()?;
        let ns_window = unsafe { &*(ptr as *const NSWindow) };
        let close = ns_window.standardWindowButton(NSWindowButton::CloseButton)?;
        let minimise = ns_window.standardWindowButton(NSWindowButton::MiniaturizeButton)?;
        let zoom = ns_window.standardWindowButton(NSWindowButton::ZoomButton)?;

        let left = close.frame().origin.x;
        let button = close.frame().size.width;
        let natural_step = *NATURAL_STEP.get_or_init(|| minimise.frame().origin.x - left);
        let tight_step = button + TIGHT_GAP;
        let step = natural_step + (tight_step - natural_step) * compact.clamp(0.0, 1.0);
        for (i, b) in [&minimise, &zoom].into_iter().enumerate() {
            let y = b.frame().origin.y;
            b.setFrameOrigin(NSPoint::new(left + step * (i as f64 + 1.0), y));
        }
        Some(Lights { button, natural_step, tight_step, width: step * 2.0 + button })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, compact);
        None
    }
}
