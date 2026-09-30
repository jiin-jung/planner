use std::{
    collections::HashSet,
    fs,
    path::PathBuf,
    sync::Mutex,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_positioner::{Position, WindowExt};

const BACKUP_KEEP: usize = 14;

/// 미니 창이 포커스를 잃어 숨겨진 시각 (트레이 클릭으로 바로 다시 열리는 것 방지)
static MINI_HIDDEN_AT: Mutex<Option<Instant>> = Mutex::new(None);

// ───────────── 데이터 저장 ─────────────

/// 앱 전용 폴더 (설정, 자동 백업): ~/Library/Application Support/com.jiin.planner/
fn app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// iCloud Drive 안의 Planner 폴더
fn icloud_dir(app: &AppHandle) -> Option<PathBuf> {
    let root = app.path().home_dir().ok()?.join("Library/Mobile Documents/com~apple~CloudDocs");
    root.is_dir().then(|| root.join("Planner"))
}

/// 데이터 파일(planner.json) 위치: config.json 의 dataDir, 없으면 앱 전용 폴더
fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app_dir(app)?;
    if let Some(dir) = fs::read_to_string(base.join("config.json"))
        .ok()
        .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
        .and_then(|v| v.get("dataDir").and_then(|d| d.as_str()).map(PathBuf::from))
    {
        if fs::create_dir_all(&dir).is_ok() {
            return Ok(dir);
        }
    }
    Ok(base)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageInfo {
    mode: String,
    path: String,
    icloud_available: bool,
}

fn storage_info(app: &AppHandle) -> Result<StorageInfo, String> {
    let dir = data_dir(app)?;
    let icloud = icloud_dir(app);
    let mode = if icloud.as_ref() == Some(&dir) { "icloud" } else { "local" };
    Ok(StorageInfo { mode: mode.into(), path: dir.to_string_lossy().into_owned(), icloud_available: icloud.is_some() })
}

#[tauri::command]
fn get_storage(app: AppHandle) -> Result<StorageInfo, String> {
    storage_info(&app)
}

/// 저장 위치 변경. strategy: "ask" (대상에 파일이 있으면 EXISTS 에러) | "use_target" | "overwrite"
#[tauri::command]
fn set_storage(app: AppHandle, mode: String, strategy: String) -> Result<StorageInfo, String> {
    let base = app_dir(&app)?;
    let target = match mode.as_str() {
        "icloud" => icloud_dir(&app).ok_or("이 맥에서 iCloud Drive를 찾지 못했어요. 시스템 설정 → Apple ID → iCloud에서 iCloud Drive를 켜 주세요.")?,
        _ => base.clone(),
    };
    let current = data_dir(&app)?;
    if target != current {
        fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        let (src, dst) = (current.join("planner.json"), target.join("planner.json"));
        if dst.exists() && strategy == "ask" {
            return Err("EXISTS".into());
        }
        if src.exists() && (!dst.exists() || strategy == "overwrite") {
            if dst.exists() {
                let _ = fs::copy(&dst, target.join("planner.before-switch.json"));
            }
            fs::copy(&src, &dst).map_err(|e| e.to_string())?;
        }
        let cfg = if target == base {
            "{}".to_string()
        } else {
            serde_json::json!({ "dataDir": target.to_string_lossy() }).to_string()
        };
        fs::write(base.join("config.json"), cfg).map_err(|e| e.to_string())?;
    }
    storage_info(&app)
}

#[tauri::command]
fn load_data(app: AppHandle) -> Result<Option<String>, String> {
    let path = data_dir(&app)?.join("planner.json");
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(path).map(Some).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_data(app: AppHandle, data: String, day: String) -> Result<(), String> {
    let dir = data_dir(&app)?;
    let path = dir.join("planner.json");
    let base = app_dir(&app)?;
    // 임시 파일에 쓰고 교체 → 저장 중 꺼져도 파일이 깨지지 않음
    let tmp = dir.join("planner.json.tmp");
    fs::write(&tmp, &data).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;

    // 하루 한 개 자동 백업 (같은 날은 덮어씀), 최근 14일치만 유지
    let safe_day: String = day.chars().filter(|c| c.is_ascii_digit() || *c == '-').collect();
    if !safe_day.is_empty() {
        let bdir = base.join("backups");
        fs::create_dir_all(&bdir).map_err(|e| e.to_string())?;
        fs::write(bdir.join(format!("planner-{safe_day}.json")), &data).map_err(|e| e.to_string())?;
        let mut files: Vec<PathBuf> = fs::read_dir(&bdir)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().map_or(false, |x| x == "json"))
            .collect();
        files.sort();
        if files.len() > BACKUP_KEEP {
            for old in &files[..files.len() - BACKUP_KEEP] {
                let _ = fs::remove_file(old);
            }
        }
    }
    Ok(())
}

/// 다운로드 폴더에 파일 저장 후 경로 반환
#[tauri::command]
fn export_file(app: AppHandle, name: String, content: String) -> Result<String, String> {
    // 한글 파일명 허용, 경로 구분자·제어 문자만 제거
    let safe: String = name
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '/' | '\\' | ':'))
        .collect();
    if safe.is_empty() || safe.starts_with('.') {
        return Err("잘못된 파일 이름".into());
    }
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    let path = dir.join(safe);
    fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

// ───────────── 알림 ─────────────

#[derive(Deserialize, Clone)]
struct Reminder {
    key: String,
    at: i64, // epoch ms
    title: String,
    body: String,
}

#[derive(Default)]
struct Reminders {
    list: Mutex<Vec<Reminder>>,
    fired: Mutex<HashSet<String>>,
}

#[tauri::command]
fn set_reminders(state: State<Reminders>, list: Vec<Reminder>) {
    *state.list.lock().unwrap() = list;
}

#[tauri::command]
fn test_notification(app: AppHandle) -> Result<(), String> {
    app.notification()
        .builder()
        .title("Planner")
        .body("알림이 잘 동작해요 🔔")
        .show()
        .map_err(|e| e.to_string())
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// 15초마다 확인해서 시간이 된 알림 발송 (10분 넘게 지난 건 버림)
fn start_reminder_loop(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(15));
        let state = app.state::<Reminders>();
        let now = now_ms();
        let due: Vec<Reminder> = state
            .list
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.at <= now && now - r.at < 10 * 60 * 1000)
            .cloned()
            .collect();
        let mut fired = state.fired.lock().unwrap();
        for r in due {
            if fired.insert(r.key.clone()) {
                let _ = app.notification().builder().title(&r.title).body(&r.body).show();
            }
        }
    });
}

// ───────────── 창 / 메뉴바 ─────────────

fn show_main_window(app: &AppHandle) {
    if let Some(mini) = app.get_webview_window("mini") {
        let _ = mini.hide();
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

// ───────────── 로그인 시 자동 실행 ─────────────

#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let m = app.autolaunch();
    if enabled { m.enable() } else { m.disable() }.map_err(|e| e.to_string())?;
    m.is_enabled().map_err(|e| e.to_string())
}

/// 창 제목줄 테마: "light" | "dark" | 그 외(시스템)
#[tauri::command]
fn set_theme(app: AppHandle, theme: String) {
    let t = match theme.as_str() {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => None,
    };
    for w in app.webview_windows().values() {
        let _ = w.set_theme(t);
    }
}

#[tauri::command]
fn show_main(app: AppHandle) {
    show_main_window(&app);
}

fn toggle_mini(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("mini") {
        let just_hidden = MINI_HIDDEN_AT
            .lock()
            .unwrap()
            .map_or(false, |t| t.elapsed() < Duration::from_millis(300));
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else if !just_hidden {
            let _ = w.move_window(Position::TrayCenter);
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_positioner::init())
        // 로그인 자동 실행 시 --hidden 으로 켜서 메뉴바에만 조용히 상주
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .manage(Reminders::default())
        .invoke_handler(tauri::generate_handler![
            load_data,
            save_data,
            export_file,
            set_reminders,
            test_notification,
            get_autostart,
            set_autostart,
            get_storage,
            set_storage,
            set_theme,
            show_main
        ])
        .setup(|app| {
            // 앱 메뉴: ⌘Z / ⌘⇧Z 를 플래너의 실행 취소로 연결
            let sep = || PredefinedMenuItem::separator(app);
            let app_menu = Submenu::with_items(app, "Planner", true, &[
                &PredefinedMenuItem::about(app, None, None)?,
                &sep()?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &sep()?,
                &PredefinedMenuItem::quit(app, None)?,
            ])?;
            let edit_menu = Submenu::with_items(app, "편집", true, &[
                &MenuItem::with_id(app, "undo", "실행 취소", true, Some("CmdOrCtrl+Z"))?,
                &MenuItem::with_id(app, "redo", "다시 실행", true, Some("CmdOrCtrl+Shift+Z"))?,
                &sep()?,
                &PredefinedMenuItem::cut(app, None)?,
                &PredefinedMenuItem::copy(app, None)?,
                &PredefinedMenuItem::paste(app, None)?,
                &PredefinedMenuItem::select_all(app, None)?,
            ])?;
            let window_menu = Submenu::with_items(app, "윈도우", true, &[
                &PredefinedMenuItem::minimize(app, None)?,
                &PredefinedMenuItem::close_window(app, None)?,
            ])?;
            app.set_menu(Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])?)?;
            app.on_menu_event(|app, event| {
                let id = event.id().as_ref();
                if id == "undo" || id == "redo" {
                    let _ = app.emit("menu", id.to_string());
                }
            });

            let open = MenuItem::with_id(app, "open", "플래너 열기", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "종료", true, Some("CmdOrCtrl+Q"))?;
            let menu = Menu::with_items(app, &[&open, &quit])?;

            TrayIconBuilder::with_id("tray")
                .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true)
                .tooltip("Planner")
                .menu(&menu)
                .show_menu_on_left_click(false) // 왼쪽 클릭: 미니 창, 오른쪽 클릭: 메뉴
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_mini(tray.app_handle());
                    }
                })
                .build(app)?;

            start_reminder_loop(app.handle().clone());

            // 일반 실행이면 메인 창 표시, 로그인 자동 실행(--hidden)이면 메뉴바에만
            if !std::env::args().any(|a| a == "--hidden") {
                show_main_window(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // 메인 창을 닫아도 앱은 메뉴바에서 계속 실행 (알림 유지)
            WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                api.prevent_close();
                let _ = window.hide();
            }
            // 미니 창은 포커스를 잃으면 숨김
            WindowEvent::Focused(false) if window.label() == "mini" => {
                *MINI_HIDDEN_AT.lock().unwrap() = Some(Instant::now());
                let _ = window.hide();
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building planner");

    app.run(|app, event| {
        // Dock 아이콘 클릭 시 메인 창 다시 열기
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            show_main_window(app);
        }
        let _ = (app, event);
    });
}
