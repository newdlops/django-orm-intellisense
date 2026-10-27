//! Paired release/dev costs of previous complete join versus direct blob chunks.
//! Inputs are complete actual daemon bytes. Allocation counters wrap Rust System;
//! they exclude file/page cache, NAPI buffers, Node and OS process RSS.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use django_orm_core::cache::{load, save, save_byte_chunks, CacheLoad};
use serde_json::json;
use sha2::{Digest, Sha256};

struct TrackingAllocator;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

fn add(bytes: usize) {
    let live = LIVE.fetch_add(bytes, Ordering::Relaxed) + bytes;
    PEAK.fetch_max(live, Ordering::Relaxed);
}

unsafe impl GlobalAlloc for TrackingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() { add(layout.size()); }
        pointer
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() { add(layout.size()); }
        pointer
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
        unsafe { System.dealloc(pointer, layout); }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let new_pointer = unsafe { System.realloc(pointer, layout, new_size) };
        if !new_pointer.is_null() {
            if new_size >= layout.size() { add(new_size-layout.size()); }
            else { LIVE.fetch_sub(layout.size()-new_size, Ordering::Relaxed); }
        }
        new_pointer
    }
}

#[global_allocator]
static ALLOCATOR: TrackingAllocator = TrackingAllocator;

fn main() {
    let mut rows = Vec::new();
    for input in std::env::args().skip(1) {
        let bytes = std::fs::read(&input).unwrap();
        let chunks: Vec<&[u8]> = bytes.chunks(32768).collect();
        let metadata = b"complete-native-cache-benchmark".to_vec();
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("cache.bin");
        let mut samples = Vec::new();
        let mut expected_envelope = None;
        for round in 0..7 {
            for mode in if round % 2 == 0 { ["previous", "current"] } else { ["current", "previous"] } {
                let baseline = LIVE.load(Ordering::Relaxed);
                PEAK.store(baseline, Ordering::Relaxed);
                let started = Instant::now();
                if mode == "previous" {
                    let mut joined = Vec::with_capacity(bytes.len());
                    for chunk in &chunks { joined.extend_from_slice(chunk); }
                    save(&target, &metadata, &joined).unwrap();
                } else {
                    save_byte_chunks(&target, &metadata, &chunks).unwrap();
                }
                let elapsed_ms = started.elapsed().as_secs_f64()*1000.0;
                let peak = PEAK.load(Ordering::Relaxed).saturating_sub(baseline);
                let retained = LIVE.load(Ordering::Relaxed).saturating_sub(baseline);
                let envelope = std::fs::read(&target).unwrap();
                let hash = format!("{:x}", Sha256::digest(&envelope));
                if let Some(expected) = &expected_envelope { assert_eq!(&hash, expected); }
                else { expected_envelope = Some(hash.clone()); }
                match load::<Vec<u8>, Vec<u8>, _>(&target, |value| value == &metadata).unwrap() {
                    CacheLoad::Hit { metadata: got_metadata, payload } => {
                        assert_eq!(got_metadata, metadata);
                        assert_eq!(payload, bytes);
                    }
                    CacheLoad::Miss => panic!("complete native cache missed"),
                }
                if round > 0 {
                    samples.push(json!({"mode": mode, "elapsedMs": elapsed_ms,
                        "rustAdditionalPeakBytes": peak, "rustRetainedDeltaBytes": retained,
                        "envelopeSha256": hash, "completeBytesEqual": true}));
                }
            }
        }
        rows.push(json!({"payloadPath": input, "payloadBytes": bytes.len(),
            "payloadSha256": format!("{:x}", Sha256::digest(&bytes)), "samples": samples}));
    }
    println!("{}", serde_json::to_string_pretty(&json!({"profile": if cfg!(debug_assertions) {"dev"} else {"release"},
        "repetitions":6, "rows": rows,
        "scope":"Six alternating full previous join+generic bincode save versus current direct borrowed chunks per payload after warmup. Rust System allocator requested live/peak bytes only during full save, exact envelope hashes and complete load values verified after measurement. Includes tempfile creation/write/flush/sync/rename and input payload excluded. Allocator realloc reports requested live delta rather than OS transient overlap. Excludes NAPI/Node/native process RSS/page cache/editor/startup/all-process peak; release and dev separate."})).unwrap());
}
