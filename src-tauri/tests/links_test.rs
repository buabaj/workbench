//! Link durability: anchors must survive edits and a restart (they are stored
//! in SQLite and re-resolved from content, never from line numbers).

use prime_workbench_lib::anchors::{self, resolve::resolve, AnchorStatus};

const RESEARCH: &str = "\
# Anchor durability

Line numbers are the weakest possible anchor. The durable representation is
derived from content, with position kept only as a hint.

Resolution tries exact hash, then unique search, then fuzzy match.
";

const CODE: &str = "\
use crate::anchors;

fn resolve_anchor(fp: &Fingerprint, content: &str) -> Resolution {
    if fp.hash == current_hash(content) {
        return Resolution::exact(fp.hint);
    }
    fuzzy(fp, content)
}
";

fn anchor_for(doc: &str, needle: &str, hash: &str) -> anchors::AnchorFingerprint {
    let from = doc.find(needle).expect("needle present");
    anchors::fingerprint(doc, from, from + needle.len(), hash)
}

#[test]
fn research_to_code_link_survives_edits_on_both_ends() {
    let claim = "The durable representation is\nderived from content";
    let impl_span = "if fp.hash == current_hash(content) {";

    let src = anchor_for(RESEARCH, claim, "r1");
    let dst = anchor_for(CODE, impl_span, "c1");

    // Both ends still resolve exactly before any edit.
    assert_eq!(resolve(&src, RESEARCH, "r1").status, AnchorStatus::Ok);
    assert_eq!(resolve(&dst, CODE, "c1").status, AnchorStatus::Ok);

    // The user rewrites the research intro and adds a section above the claim.
    let edited_research = RESEARCH
        .replace("# Anchor durability", "# Anchor durability\n\n## Background\n\nWhy this matters at all.")
        .replace("Line numbers are the weakest possible anchor.", "Line numbers are fragile.");

    // The agent refactors the code, inserting a function above the target.
    let edited_code = CODE.replace(
        "fn resolve_anchor",
        "fn current_hash(content: &str) -> u64 {\n    blake3(content)\n}\n\nfn resolve_anchor",
    );

    let r_src = resolve(&src, &edited_research, "r2");
    let r_dst = resolve(&dst, &edited_code, "c2");

    assert_eq!(r_src.status, AnchorStatus::Ok, "research anchor drifted");
    assert_eq!(&edited_research[r_src.from..r_src.to], claim);

    assert_eq!(r_dst.status, AnchorStatus::Ok, "code anchor drifted");
    assert_eq!(&edited_code[r_dst.from..r_dst.to], impl_span);
}

#[test]
fn anchor_state_round_trips_through_sqlite() {
    // What persistence actually stores: the fingerprint, not offsets. Reloading
    // it (as after an app restart) must resolve identically.
    let dir = tempfile::tempdir().unwrap();
    let conn = prime_workbench_lib::db::open(&dir.path().join("t.db")).unwrap();
    conn.execute(
        "INSERT INTO workspaces (id, name, root_path, root_real, kind, created_at)
         VALUES ('ws', 'w', '/x', '/x', 'plain', 0)",
        [],
    )
    .unwrap();

    let claim = "Resolution tries exact hash";
    let fp = anchor_for(RESEARCH, claim, "r1");
    conn.execute(
        "INSERT INTO anchors (id, workspace_id, rel_path, exact_text, prefix_text, suffix_text,
                              hint_from, hint_to, file_hash_at_create, created_at)
         VALUES ('a1','ws','notes.md',?1,?2,?3,?4,?5,?6,0)",
        rusqlite::params![
            fp.exact_text,
            fp.prefix_text,
            fp.suffix_text,
            fp.hint_from as i64,
            fp.hint_to as i64,
            fp.file_hash_at_create
        ],
    )
    .unwrap();

    // Reopen the database — the restart boundary.
    drop(conn);
    let conn = prime_workbench_lib::db::open(&dir.path().join("t.db")).unwrap();
    let loaded = conn
        .query_row(
            "SELECT exact_text, prefix_text, suffix_text, hint_from, hint_to, file_hash_at_create
               FROM anchors WHERE id = 'a1'",
            [],
            |r| {
                Ok(anchors::AnchorFingerprint {
                    exact_text: r.get(0)?,
                    prefix_text: r.get(1)?,
                    suffix_text: r.get(2)?,
                    hint_from: r.get::<_, i64>(3)? as usize,
                    hint_to: r.get::<_, i64>(4)? as usize,
                    file_hash_at_create: r.get(5)?,
                })
            },
        )
        .unwrap();

    let edited = format!("# New title added after restart\n\n{RESEARCH}");
    let r = resolve(&loaded, &edited, "r2");
    assert_eq!(r.status, AnchorStatus::Ok);
    assert_eq!(&edited[r.from..r.to], claim);
}

#[test]
fn link_rows_cascade_when_an_anchor_disappears() {
    let dir = tempfile::tempdir().unwrap();
    let conn = prime_workbench_lib::db::open(&dir.path().join("t.db")).unwrap();
    conn.execute(
        "INSERT INTO workspaces (id, name, root_path, root_real, kind, created_at)
         VALUES ('ws','w','/x','/x','plain',0)",
        [],
    )
    .unwrap();
    for id in ["a1", "a2"] {
        conn.execute(
            "INSERT INTO anchors (id, workspace_id, rel_path, exact_text, hint_from, hint_to,
                                  file_hash_at_create, created_at)
             VALUES (?1,'ws','f.md','text',0,4,'h',0)",
            [id],
        )
        .unwrap();
    }
    conn.execute(
        "INSERT INTO links (id, workspace_id, kind, src_anchor_id, dst_anchor_id, created_at)
         VALUES ('l1','ws','supports','a1','a2',0)",
        [],
    )
    .unwrap();

    // Deleting an anchor must not leave a dangling link row.
    conn.execute("DELETE FROM anchors WHERE id = 'a1'", []).unwrap();
    let remaining: i64 = conn
        .query_row("SELECT count(*) FROM links", [], |r| r.get(0))
        .unwrap();
    assert_eq!(remaining, 0, "link outlived its anchor");
}

#[test]
fn duplicate_links_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let conn = prime_workbench_lib::db::open(&dir.path().join("t.db")).unwrap();
    conn.execute(
        "INSERT INTO workspaces (id, name, root_path, root_real, kind, created_at)
         VALUES ('ws','w','/x','/x','plain',0)",
        [],
    )
    .unwrap();
    for id in ["a1", "a2"] {
        conn.execute(
            "INSERT INTO anchors (id, workspace_id, rel_path, exact_text, hint_from, hint_to,
                                  file_hash_at_create, created_at)
             VALUES (?1,'ws','f.md','text',0,4,'h',0)",
            [id],
        )
        .unwrap();
    }
    let insert = |id: &str| {
        conn.execute(
            "INSERT INTO links (id, workspace_id, kind, src_anchor_id, dst_anchor_id, created_at)
             VALUES (?1,'ws','supports','a1','a2',0)",
            [id],
        )
    };
    assert!(insert("l1").is_ok());
    assert!(insert("l2").is_err(), "same triple inserted twice");
}
