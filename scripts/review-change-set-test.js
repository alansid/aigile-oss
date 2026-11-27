import assert from 'node:assert/strict';
import { fetchReviewChanges, testGitHubRepo } from '../src/review-manifest.js';
const repo = { url:'https://github.com/example/demo.git' };
const version = '1'.repeat(40);
const files = [{ filename:'example.js', status:'modified', additions:600, deletions:0, patch:'@@ -0,0 +1,600 @@\n' + '+fixture\n'.repeat(600) }];
const fetchImpl = async (url, opts) => {
  assert.equal(new URL(url).hostname,'api.github.com');
  assert.equal(opts.redirect,'error');
  return Response.json({sha:version,parents:[{sha:'2'.repeat(40)}],files});
};
const metadata = await fetchReviewChanges(repo,version,{fetchImpl});
assert.equal(metadata.patches.length,0);
assert.equal(metadata.manifest.files[0].added,600);
const rich = await fetchReviewChanges(repo,version,{fetchImpl,allowContent:true});
assert.equal(rich.patches[0].lines.length,500);
assert.equal(rich.manifest.files[0].truncated,true);
await assert.rejects(fetchReviewChanges(repo,'not-a-sha',{fetchImpl}));
await assert.rejects(fetchReviewChanges({url:'https://github.com.evil.test/team/repo'},version,{fetchImpl}));
await assert.rejects(fetchReviewChanges(repo,version,{fetchImpl:async()=>Response.json({}, {status:404})}),/找不到/);
await assert.rejects(fetchReviewChanges(repo,version,{fetchImpl:async()=>Response.json({sha:'3'.repeat(40),files})}),/版本/);
const urls = [];
assert.equal((await testGitHubRepo(repo.url,'topic/one',async url=>{
  urls.push(url);
  return Response.json({full_name:'example/demo',default_branch:'main',commit:{sha:version}});
})).branch,'topic/one');
assert.equal(urls[1],'https://api.github.com/repos/example/demo/branches/topic%2Fone');
console.log('GitHub review snapshots, restricted statistics, error handling and connection checks passed');

process.env.AIGILE_MCP_NO_MAIN = '1';
const { collectLocalReview } = await import('../public/aigile-mcp.mjs');
const diff = Buffer.from('diff --git a/sample b/sample\n--- a/sample\n+++ b/sample\n@@ -1 +1 @@\n-old\n+new\n');
const fake = origin => ({origin, git:(...args)=>args.includes('--numstat') ? Buffer.from('1\t1\tsample\0') : diff});
const repos = [fake('https://github.com/example/platform'),fake('https://github.com/example/oss')];
const {createHash} = await import('node:crypto');
const combined = createHash('sha256').update(diff).update(diff).digest('hex');
const two = collectLocalReview(repos,combined,true);
assert.equal(two.repositories.length,2);
assert.equal(two.files[1].lines.at(-1),'+new');
assert.equal(collectLocalReview(repos,combined,false).files[0].lines,undefined);
assert.throws(()=>collectLocalReview(repos,'a'.repeat(64),true),/指紋/);

const {prepareReview} = await import('../public/aigile-mcp.mjs');
assert.deepEqual(prepareReview({version,origin:'untrusted'}),{args:{version},repos:[]});
assert.throws(()=>prepareReview({worktrees:[]}));
assert.throws(()=>prepareReview({worktree:'wrong'},()=>{throw new Error('missing')}));
assert.deepEqual(prepareReview({worktrees:['platform','oss']},origin=>({origin})).args.origins,['platform','oss']);
