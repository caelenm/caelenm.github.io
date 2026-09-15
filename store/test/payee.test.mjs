// Tests for payee node id recovery — the check that binds a payment to a
// specific wallet.
//
//   node test/payee.test.mjs
//
// The function under test is extracted verbatim from index.html, so these
// exercise shipped code. Expected values come from the BOLT-11 spec vectors
// (all issued by one known node) and were cross-checked against the `bolt11`
// package during development.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "index.html"), "utf8");

// payeeNodeId depends on the BTCMSG module, so pull both out together.
const btcmsg = html.match(/const BTCMSG = \(\(\) => \{[\s\S]*?\n\}\)\(\);/);
const fn = html.match(/async function payeeNodeId\(invoice\)\{[\s\S]*?\n  return\{nodeId:hex\(BTCMSG\.serPub\(Q,true\)\),source:"signature"\}\}/);
if (!btcmsg || !fn) { console.error("FATAL: could not extract BTCMSG / payeeNodeId from index.html"); process.exit(1); }

const { payeeNodeId } = await import("data:text/javascript," + encodeURIComponent(
  btcmsg[0] + "\n" + fn[0] + "\nexport { payeeNodeId };"));

let pass = 0, fail = 0;
const bad = (m) => { console.log("FAIL " + m); fail++; };
const eq = (a, b, name) => { if (a === b) pass++; else bad(`${name}\n    got  ${a}\n    want ${b}`); };

// Every BOLT-11 spec example is issued by this node.
const SPEC_NODE = "03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad";
const SPEC = [
  "lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql",
  "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh",
  "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpquwpc4curk03c9wlrswe78q4eyqc7d8d0xqzpu9qrsgqhtjpauu9ur7fw2thcl4y9vfvh4m9wlfyz2gem29g5ghe2aak2pm3ps8fdhtceqsaagty2vph7utlgj48u0ged6a337aewvraedendscp573dxr",
  "lnbc20m1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqhp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqs9qrsgq7ea976txfraylvgzuxs8kgcw23ezlrszfnh8r6qtfpr6cxga50aj6txm9rxrydzd06dfeawfk6swupvz4erwnyutnjq7x39ymw6j38gp7ynn44",
  "lntb20m1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygshp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqfpp3x9et2e20v6pu37c5d9vax37wxq72un989qrsgqdj545axuxtnfemtpwkc45hx9d2ft7x04mt8q7y6t0k2dge9e7h8kpy9p34ytyslj3yu569aalz2xdk8xkd7ltxqld94u8h2esmsmacgpghe9k8",
];
for (const [i, inv] of SPEC.entries()) {
  const r = await payeeNodeId(inv);
  eq(r.nodeId, SPEC_NODE, `spec vector ${i + 1} recovers the issuing node`);
}

// Two real invoices from one wallet must recover the same node id.
const REAL_NODE = "02ceb3f8c65aec63fd3529f538a56690aeba10981c09aadb163e097da5589c67aa";
const REAL = [
  "lnbc90n1p4fhpz7pp57sus2s7qd8pg89033r9ynzg8mrr653u07r5zs5g6l6ng2a2w2l3qhp5ah2qyz8g3ktjgc7ekln3c8q785nw0ytktuqskt70n7893cvrkkkqcqzzsxqrrssrzjqd82srutzjx82prr234anxdlwvs6peklcc92lp9aqsq296xnwmqd2r4e8cqq3ecqqqqqqqlgqqqqpjqq2qsp5teddjszrumdazqq29lunfmr4zvdl4v8kjqcclwrnwlfxnrwe53ts9qxpqysgqg5l00e3jhcyrfev6hsk39q4n4ju48vsfhlk0dwfnzgr7rznf7cqzvrpe6jw7w2mljv3a7tnjjctcvphn07w9kzrkmpwlhwjm7r03eycq0xhtxy",
  "lnbc90n1p4fhz23pp5cq6rvdsra0td5dlj5zfwl7zeh450jdhthxw3a038n3ugvsg5y7sqhp55lpt27e24h3y5w4m3fx7lhhyzvzezldqp87t0j4d2pdmju47xy3qcqzzsxqrrssrzjqd82srutzjx82prr234anxdlwvs6peklcc92lp9aqsq296xnwmqd2r4e8cqq3ecqqqqqqqlgqqqqpjqq2qsp5v4fwg8987j6hc8j6z39xs7p8j8xm8ueld2ks9zs0xu3y09v24eds9qxpqysgqptuy7dvhhh5u8523aq2sskj58pwy304tted0c7eyuccuuswz4lnrvw4y45x2upg0vxldc0zf6seu8vvjvctzxjlhyrfs083dnnksnlqph2cnhl",
];
for (const [i, inv] of REAL.entries()) {
  const r = await payeeNodeId(inv);
  eq(r.nodeId, REAL_NODE, `real invoice ${i + 1} recovers the wallet's node`);
  eq(r.source, "signature", `real invoice ${i + 1} used signature recovery`);
}

// The attack this exists to stop: same amount, same payment hash, valid
// preimage, valid signature — but issued by someone else's node.
{
  const FORGED = "lnbc90n1p4fhva2pp54apg9drcjylqgvphz3t7p4txh73648w4zkqgk6m2gkdutshapdgsdqsw35x2gr0vf4x2cm5xqrrsscqpfl5yllznhrkne0shuzjahst3ntfdn52dwlfnvd8dxuufz7udstcfny4z7euualxff53vty3httpfnpcswwucpuyuv5wwnupf0vme4arqqz7yqrk";
  const r = await payeeNodeId(FORGED);
  eq(r.nodeId, "0265c9e0fb1849ca0ceb138f3ef25208331153acbaec025ed160b59f80120ea4c6",
    "forged invoice recovers the attacker's node");
  if (r.nodeId !== REAL_NODE) pass++; else bad("forged invoice attributed to the real wallet");
}

// Tampering anywhere under the signature must change the answer.
{
  let changed = 0;
  for (let n = 0; n < 12; n++) {
    const inv = REAL[0];
    const i = 20 + Math.floor(Math.random() * (inv.length - 30));
    const ch = inv[i] === "q" ? "p" : "q";
    const t = inv.slice(0, i) + ch + inv.slice(i + 1);
    try { if ((await payeeNodeId(t)).nodeId !== REAL_NODE) changed++; }
    catch { changed++; }
  }
  if (changed === 12) pass++; else bad(`only ${changed}/12 tampered invoices changed the node id`);
}

// Junk must throw, never return a plausible-looking id.
for (const junk of ["", "hello", "lnbc1", "lnbcQQQQ", "not-an-invoice"]) {
  try { await payeeNodeId(junk); bad(`junk accepted: ${JSON.stringify(junk)}`); }
  catch { pass++; }
}

console.log(fail === 0
  ? `payee node id: all ${pass} checks passed`
  : `payee node id: ${fail} FAILED, ${pass} passed`);
process.exit(fail ? 1 : 0);
