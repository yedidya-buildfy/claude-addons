//! Temperatures from the SoC's HID thermal sensors (what Stats / macmon read; no root needed).

use core_foundation::array::CFArray;
use core_foundation::base::{CFRelease, CFType, TCFType};
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use std::ffi::c_void;

type Ref = *const c_void;

#[link(name = "IOKit", kind = "framework")]
unsafe extern "C" {
    fn IOHIDEventSystemClientCreate(alloc: Ref) -> Ref;
    fn IOHIDEventSystemClientSetMatching(client: Ref, matching: Ref) -> i32;
    fn IOHIDEventSystemClientCopyServices(client: Ref) -> Ref;
    fn IOHIDServiceClientCopyProperty(service: Ref, key: Ref) -> Ref;
    fn IOHIDServiceClientCopyEvent(service: Ref, kind: i64, a: i32, b: i64) -> Ref;
    fn IOHIDEventGetFloatValue(event: Ref, field: u32) -> f64;
}

const TEMPERATURE: i64 = 15;

pub struct Sensors {
    client: Ref,
}

unsafe impl Send for Sensors {}

impl Sensors {
    pub fn new() -> Sensors {
        unsafe {
            let client = IOHIDEventSystemClientCreate(std::ptr::null());
            // vendor page 0xff00, usage 5 = temperature sensors
            let matching = CFDictionary::from_CFType_pairs(&[
                (CFString::new("PrimaryUsagePage"), CFNumber::from(0xff00i32)),
                (CFString::new("PrimaryUsage"), CFNumber::from(5i32)),
            ]);
            IOHIDEventSystemClientSetMatching(client, matching.as_concrete_TypeRef() as Ref);
            Sensors { client }
        }
    }

    /// (sensor name, °C) for every sensor that answers.
    pub fn read(&self) -> Vec<(String, f32)> {
        let mut out = Vec::new();
        unsafe {
            let services = IOHIDEventSystemClientCopyServices(self.client);
            if services.is_null() {
                return out;
            }
            let services: CFArray<CFType> = CFArray::wrap_under_create_rule(services as _);
            let key = CFString::new("Product");
            for s in services.iter() {
                let s = s.as_CFTypeRef();
                let name = IOHIDServiceClientCopyProperty(s, key.as_concrete_TypeRef() as Ref);
                if name.is_null() {
                    continue;
                }
                let name = CFString::wrap_under_create_rule(name as _).to_string();
                let ev = IOHIDServiceClientCopyEvent(s, TEMPERATURE, 0, 0);
                if ev.is_null() {
                    continue;
                }
                let t = IOHIDEventGetFloatValue(ev, (TEMPERATURE as u32) << 16) as f32;
                CFRelease(ev);
                if t > 0.0 && t < 150.0 {
                    out.push((name, t));
                }
            }
        }
        out
    }
}

/// Hottest reading per part, °C (0 when the Mac has no such sensor).
#[derive(Default, Clone, Copy)]
pub struct Temps {
    pub cpu: f32,     // CPU dies ("PMU tdie*")
    pub gpu: f32,     // GPU clusters ("PMU TP*g")
    pub soc: f32,     // rest of the chip ("PMU TP*s")
    pub ssd: f32,     // "NAND CH0 temp"
    pub battery: f32, // "gas gauge battery"
}

pub fn summarize(all: &[(String, f32)]) -> Temps {
    let max = |f: &dyn Fn(&str) -> bool| all.iter().filter(|(n, _)| f(n)).map(|x| x.1).fold(0.0, f32::max);
    let tp = |n: &str, last: char| n.starts_with("PMU TP") && n.ends_with(last);
    Temps {
        cpu: max(&|n| n.contains("tdie")),
        gpu: max(&|n| tp(n, 'g')),
        soc: max(&|n| tp(n, 's')),
        ssd: max(&|n| n.starts_with("NAND")),
        battery: max(&|n| n.to_lowercase().contains("battery")),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_die_temperature_without_root() {
        let all = super::Sensors::new().read();
        let t = super::summarize(&all);
        assert!(t.cpu > 10.0 && t.cpu < 120.0, "cpu die {} °C", t.cpu);
    }
}
