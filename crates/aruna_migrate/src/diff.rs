// Unified diffs for `aruna migrate --dry-run`: a line diff (Myers' O(ND)
// algorithm) grouped into hunks with three lines of context, in the format
// `git diff` and `patch` read.

const CONTEXT: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Op {
    Equal,
    Delete,
    Insert,
}

// Lines with their terminators, so a missing final newline is visible.
fn split_lines(text: &str) -> Vec<&str> {
    text.split_inclusive('\n').collect()
}

// The shortest edit script from `a` to `b`, as (op, index into a or b) steps.
// `trace[d]` is the furthest-reaching x per diagonal before round `d`; the
// script is read back from it.
fn myers(a: &[&str], b: &[&str]) -> Vec<(Op, usize)> {
    let n = a.len() as isize;
    let m = b.len() as isize;
    let max = (n + m) as usize;
    let offset = max as isize + 1;
    let mut v = vec![0isize; 2 * max + 3];
    let mut trace: Vec<Vec<isize>> = Vec::new();

    'search: for d in 0..=max as isize {
        trace.push(v.clone());
        let mut k = -d;
        while k <= d {
            let index = (k + offset) as usize;
            let mut x = if k == -d || (k != d && v[index - 1] < v[index + 1]) {
                v[index + 1]
            } else {
                v[index - 1] + 1
            };
            let mut y = x - k;
            while x < n && y < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            v[index] = x;
            if x >= n && y >= m {
                break 'search;
            }
            k += 2;
        }
    }

    let mut script = Vec::new();
    let (mut x, mut y) = (n, m);
    for (d, v) in trace.iter().enumerate().rev() {
        let d = d as isize;
        let k = x - y;
        let index = (k + offset) as usize;
        let previous_k = if k == -d || (k != d && v[index - 1] < v[index + 1]) {
            k + 1
        } else {
            k - 1
        };
        let previous_x = v[(previous_k + offset) as usize];
        let previous_y = previous_x - previous_k;
        while x > previous_x && y > previous_y {
            x -= 1;
            y -= 1;
            script.push((Op::Equal, x as usize));
        }
        if d > 0 {
            if x == previous_x {
                script.push((Op::Insert, (y - 1) as usize));
            } else {
                script.push((Op::Delete, (x - 1) as usize));
            }
        }
        x = previous_x;
        y = previous_y;
    }
    script.reverse();
    script
}

fn push_line(out: &mut String, prefix: char, line: &str) {
    out.push(prefix);
    out.push_str(line);
    if !line.ends_with('\n') {
        out.push_str("\n\\ No newline at end of file\n");
    }
}

/// A unified diff of `before` → `after` for `path`, or an empty string when
/// they are equal.
pub fn unified_diff(path: &str, before: &str, after: &str) -> String {
    if before == after {
        return String::new();
    }
    let a = split_lines(before);
    let b = split_lines(after);
    let script = myers(&a, &b);

    // Each step's position in both files, so hunks can report line ranges.
    struct Step {
        op: Op,
        a_line: usize,
        b_line: usize,
        text: usize,
    }
    let mut steps = Vec::with_capacity(script.len());
    let (mut a_line, mut b_line) = (0usize, 0usize);
    for (op, index) in script {
        steps.push(Step {
            op,
            a_line,
            b_line,
            text: index,
        });
        match op {
            Op::Equal => {
                a_line += 1;
                b_line += 1;
            }
            Op::Delete => a_line += 1,
            Op::Insert => b_line += 1,
        }
    }

    let changed: Vec<usize> = steps
        .iter()
        .enumerate()
        .filter(|(_, step)| step.op != Op::Equal)
        .map(|(index, _)| index)
        .collect();

    let mut out = format!("--- a/{path}\n+++ b/{path}\n");
    let mut cursor = 0usize;
    while cursor < changed.len() {
        // Grow the hunk while the next change is within two contexts' reach.
        let first = changed[cursor];
        let mut last = first;
        while cursor + 1 < changed.len() && changed[cursor + 1] - last <= 2 * CONTEXT + 1 {
            cursor += 1;
            last = changed[cursor];
        }
        cursor += 1;
        let start = first.saturating_sub(CONTEXT);
        let end = (last + CONTEXT + 1).min(steps.len());
        let hunk = &steps[start..end];

        let a_count = hunk.iter().filter(|step| step.op != Op::Insert).count();
        let b_count = hunk.iter().filter(|step| step.op != Op::Delete).count();
        let a_start = if a_count == 0 { hunk[0].a_line } else { hunk[0].a_line + 1 };
        let b_start = if b_count == 0 { hunk[0].b_line } else { hunk[0].b_line + 1 };
        out.push_str(&format!("@@ -{a_start},{a_count} +{b_start},{b_count} @@\n"));
        for step in hunk {
            match step.op {
                Op::Equal => push_line(&mut out, ' ', a[step.text]),
                Op::Delete => push_line(&mut out, '-', a[step.text]),
                Op::Insert => push_line(&mut out, '+', b[step.text]),
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal_texts_have_no_diff() {
        assert_eq!(unified_diff("a.ts", "x\n", "x\n"), "");
    }

    #[test]
    fn a_one_line_change_gets_one_hunk_with_context() {
        let before = "1\n2\n3\n4\n5\n6\n7\n8\n9\n";
        let after = "1\n2\n3\n4\nfive\n6\n7\n8\n9\n";
        assert_eq!(
            unified_diff("src/a.ts", before, after),
            "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -2,7 +2,7 @@\n 2\n 3\n 4\n-5\n+five\n 6\n 7\n 8\n"
        );
    }

    #[test]
    fn distant_changes_get_separate_hunks() {
        let before: String = (1..=20).map(|n| format!("{n}\n")).collect();
        let after = before.replace("2\n", "two\n").replace("19\n", "nineteen\n");
        let diff = unified_diff("a.ts", &before, &after);
        assert_eq!(diff.matches("@@ -").count(), 2);
        assert!(diff.contains("@@ -1,5 +1,5 @@\n 1\n-2\n+two\n 3\n 4\n 5\n"));
        assert!(diff.contains("-19\n+nineteen\n 20\n"));
    }

    #[test]
    fn insertions_and_a_missing_final_newline() {
        let diff = unified_diff("a.ts", "a\nb", "a\nx\nb");
        assert_eq!(
            diff,
            "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n a\n+x\n b\n\\ No newline at end of file\n"
        );
    }
}
