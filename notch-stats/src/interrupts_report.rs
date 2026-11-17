//! The interruption report for a partner, in Hebrew: totals, a bar per day and every interruption with
//! its absolute times. Same numbers as the Log tab (both read `interrupts` + screen time).

use crate::interrupts as int;
use crate::log_view::hm;
use crate::screentime as st;
use chrono::{Datelike, NaiveDate};
use std::io::Write;
use std::process::{Command, Stdio};

pub struct Report {
    pub html: String,
    pub text: String,
}

/// Duration in Hebrew: "15 דק׳", "1 ש׳ 05 דק׳".
fn fmt(secs: u64) -> String {
    let m = secs / 60;
    if m < 60 { format!("{m} דק׳") } else { format!("{} ש׳ {:02} דק׳", m / 60, m % 60) }
}

const DAYS_HE: [&str; 7] = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

fn day_he(d: NaiveDate) -> String {
    format!("יום {} {}", DAYS_HE[d.weekday().num_days_from_sunday() as usize], d.format("%-d.%-m"))
}

pub fn build(first: NaiveDate, end: NaiveDate, now: u64) -> Report {
    let sm = int::summary(first, end, now);
    let (lost, share) = (sm.lost, sm.share());
    let focus = if sm.list.iter().any(|x| x.1.is_some()) { fmt(sm.focus) } else { "—".into() };
    let last = end.pred_opt().unwrap();
    let range = if first == last { day_he(first) } else { format!("{} – {}", first.format("%-d.%-m"), last.format("%-d.%-m.%Y")) };

    let mut text = format!(
        "יומן הפרעות · {range}\nהפרעות: {}\nזמן הפרעה: {}\nזמן חזרה לריכוז: {}\nמתוך שעות העבודה: {share:.0}%\n\n",
        sm.list.len(),
        fmt(lost),
        focus
    );
    let mut rows = String::new();
    let mut bars = String::new();
    let max = sm.per_day.iter().map(|x| x.1).max().unwrap_or(1).max(1);
    for (d, (n, m)) in sm.days.iter().zip(&sm.per_day) {
        if sm.days.len() > 1 {
            bars.push_str(&format!(
                "<div class=b><i style=\"height:{}%\"></i><span>{}<br>{n} · {}</span></div>",
                m * 100 / max,
                DAYS_HE[d.weekday().num_days_from_sunday() as usize],
                fmt(*m)
            ));
        }
    }
    if !bars.is_empty() {
        bars = format!("<div class=bars>{bars}</div>");
    }
    for (i, f) in &sm.list {
        let f = f.map_or("—".to_string(), fmt);
        let d = day_he(st::local_day(i.s));
        text.push_str(&format!("{d}  {} – {}  ({}), חזרה לריכוז {f}\n", hm(i.s), hm(i.e), fmt(i.e - i.s)));
        rows.push_str(&format!("<tr><td>{d}</td><td class=n>{}</td><td class=n>{}</td><td class=n>{}</td><td class=n>{f}</td></tr>", hm(i.s), hm(i.e), fmt(i.e - i.s)));
    }
    let html = format!(
        r#"<!doctype html><html lang=he dir=rtl><head><meta charset=utf-8><title>יומן הפרעות · {range}</title><style>
body{{font-family:-apple-system,"Heebo",sans-serif;max-width:760px;margin:32px auto;padding:0 16px;color:#111;background:#fff}}
h1{{font-size:22px;margin:0 0 4px}}.sub{{color:#666}}
.k{{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:20px 0}}.k div{{background:#f4f4f6;border-radius:8px;padding:10px}}
.k b{{display:block;font-size:22px}}.red{{color:#d70015}}
.bars{{display:flex;gap:8px;height:150px;align-items:flex-end;margin:10px 0 24px}}.b{{flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:100%;text-align:center;font-size:11px;color:#666}}
.b i{{display:block;background:#ff453a;border-radius:3px 3px 0 0;margin:0 20%}}
table{{width:100%;border-collapse:collapse;font-size:13px}}td,th{{padding:6px 4px;border-bottom:1px solid #eee;text-align:right}}
.n{{font-variant-numeric:tabular-nums;white-space:nowrap}}
</style></head><body><h1>יומן הפרעות בעבודה</h1><div class=sub>{range} · כל הפרעה סומנה ידנית ברגע שהתחילה ונגמרה</div>
<div class=k><div>הפרעות<b>{}</b></div><div>זמן הפרעה<b class=red>{}</b></div><div>זמן חזרה לריכוז<b>{}</b></div><div>מתוך שעות העבודה<b>{share:.0}%</b></div></div>
{bars}
<table><tr><th>יום</th><th>התחלה</th><th>סיום</th><th>משך</th><th>חזרה לריכוז</th></tr>{rows}</table>
<p class=sub>זמן חזרה לריכוז = כמה זמן אחרי סוף ההפרעה חזרתי לפרויקט שעבדתי עליו לפניה (נמדד מזמן המסך; מעל שעה לא נספר).</p>
</body></html>"#,
        sm.list.len(),
        fmt(lost),
        focus
    );
    Report { html, text }
}

/// Writes the page next to the data and opens it in the default browser; returns what to tell the owner.
pub fn open(r: &Report) -> &'static str {
    let path = crate::stats::data_dir().join("interruptions-report.html");
    if std::fs::write(&path, &r.html).is_err() {
        return "Could not write the report";
    }
    let _ = Command::new("/usr/bin/open").arg(&path).spawn();
    "Report opened"
}

pub fn copy(r: &Report) -> &'static str {
    let ok = Command::new("/usr/bin/pbcopy")
        .stdin(Stdio::piped())
        .spawn()
        .and_then(|mut c| {
            c.stdin.take().unwrap().write_all(r.text.as_bytes())?;
            c.wait()
        })
        .is_ok_and(|s| s.success());
    if ok { "Copied" } else { "Could not copy" }
}

#[cfg(test)]
mod tests {
    #[test]
    fn report_has_the_totals_in_hebrew() {
        let today = chrono::Local::now().date_naive();
        let r = super::build(today, today.succ_opt().unwrap(), crate::stats::unix_secs());
        assert!(r.html.contains("יומן הפרעות בעבודה") && r.text.starts_with("יומן הפרעות"));
        if let Some(out) = std::env::var_os("REPORT_OUT") {
            std::fs::write(out, &r.html).unwrap(); // a look at the page by hand
        }
    }
}
