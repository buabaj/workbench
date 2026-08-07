//! Live harness: reclaim a stale session lease. `reclaim <leases_dir> <session>`
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let done = workbench_lib::agent::lease::reclaim(
        std::path::Path::new(&a[1]),
        std::path::Path::new(&a[2]),
        workbench_lib::agent::lease::OnLiveOwner::Evict,
    );
    println!("{done}");
}
