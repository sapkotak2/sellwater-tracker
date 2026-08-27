import assert from "node:assert";
import { parseCsv, parseAdsCsv, summariseAds } from "./lib/ads.mjs";
import { dailyVisits, buildRecords, deriveLive } from "./lib/derive.mjs";

let n=0; const t=(name,fn)=>{try{fn();n++;console.log("  ok  "+name)}catch(e){console.log("  FAIL "+name+": "+e.message);process.exitCode=1}};

console.log("CSV parser");
t("quoted commas", ()=>{
  const r=parseCsv('a,b\n"one, two",3');
  assert.deepStrictEqual(r[1],["one, two","3"]);
});
t("escaped quotes", ()=>{
  const r=parseCsv('a\n"say ""hi"""');
  assert.strictEqual(r[1][0],'say "hi"');
});
t("CRLF and BOM", ()=>{
  const r=parseCsv('\uFEFFa,b\r\n1,2\r\n');
  assert.deepStrictEqual(r[0],["a","b"]);
  assert.deepStrictEqual(r[1],["1","2"]);
});
t("title row before header", ()=>{
  const c=parseAdsCsv('My Report Export\n\nCampaign name,Spent,Impressions\nAlpha,"5.00 USD","1,200"');
  assert.strictEqual(c.length,1);
  assert.strictEqual(c[0].campaign,"Alpha");
  assert.strictEqual(c[0].spent,5);
  assert.strictEqual(c[0].impressions,1200);
});
t("unit stripping", ()=>{
  const c=parseAdsCsv('Campaign name,Spent,Impressions,CTR,Clicks,Playtime\nA,"40.90 USD","388,512","2.99%","11,617","248 hrs"');
  assert.strictEqual(c[0].spent,40.9);
  assert.strictEqual(c[0].ctr,2.99);
  assert.strictEqual(c[0].playtimeHours,248);
});
t("hh:mm:ss playtime", ()=>{
  const c=parseAdsCsv('Campaign name,Spent,Plays,Playtime\nA,1,1,"4:30:00"');
  assert.strictEqual(c[0].playtimeHours,4.5);
});
t("minutes playtime", ()=>{
  const c=parseAdsCsv('Campaign name,Spent,Plays,Playtime\nA,1,1,"90 min"');
  assert.strictEqual(c[0].playtimeHours,1.5);
});
t("em dash means empty", ()=>{
  const c=parseAdsCsv('Campaign name,Spent,Impressions,CTR\nA,"0.01 USD",3,"—"');
  assert.strictEqual(c[0].ctr,null);
});
t("derives missing cpp and cpm", ()=>{
  const c=parseAdsCsv('Campaign name,Spent,Impressions,Clicks,Plays\nA,10,1000,50,20');
  assert.strictEqual(c[0].cpp,0.5);
  assert.strictEqual(c[0].cpc,0.2);
  assert.strictEqual(c[0].cpm,10);
  assert.strictEqual(c[0].ctr,5);
});
t("unmapped columns kept", ()=>{
  const c=parseAdsCsv('Campaign name,Spent,Impressions,Mystery Metric\nA,1,2,"xyz"');
  assert.strictEqual(c[0].extra["Mystery Metric"],"xyz");
});
t("empty rows ignored", ()=>{
  const c=parseAdsCsv('Campaign name,Spent,Impressions\nA,1,2\n,,\n');
  assert.strictEqual(c.length,1);
});
t("summary maths", ()=>{
  const s=summariseAds([{spent:10,impressions:1000,clicks:50,plays:20,playtimeHours:5},
                        {spent:5,impressions:500,clicks:10,plays:5,playtimeHours:2}]);
  assert.strictEqual(s.spent,15);
  assert.strictEqual(s.cpp,15/25);
  assert.strictEqual(s.ctr,(60/1500)*100);
  assert.strictEqual(s.costPerPlaytimeHour,15/7);
});

console.log("derive");
const mk=(iso,o)=>({iso,epoch:Date.parse(iso),...o});
const rows=[
  mk("2026-08-25T00:00:00Z",{ccu:10,visits:100,favorites:5,upVotes:9,downVotes:1,ratingPct:90}),
  mk("2026-08-25T23:00:00Z",{ccu:20,visits:150,favorites:7,upVotes:10,downVotes:1,ratingPct:90.9}),
  mk("2026-08-26T23:00:00Z",{ccu:15,visits:230,favorites:9,upVotes:12,downVotes:2,ratingPct:85.7}),
];
t("daily visits diff", ()=>{
  const d=dailyVisits(rows);
  assert.strictEqual(d.length,2);
  assert.strictEqual(d[0].visitsGained,null);
  assert.strictEqual(d[1].visitsGained,80);
  assert.strictEqual(d[0].peakCcu,20);
});
t("records track peaks", ()=>{
  const r=buildRecords(rows,{});
  assert.strictEqual(r.peakCcu,20);
  assert.strictEqual(r.peakVisitsPerDay,80);
  assert.strictEqual(r.bestRatingPct,90.9);
});
t("records carry previous peak forward", ()=>{
  const r=buildRecords(rows,{peakCcu:99,peakCcuAt:"old"});
  assert.strictEqual(r.peakCcu,99);
});
t("live derives server fill and funnel", ()=>{
  const snap={servers:[{playing:6,maxPlayers:6,ping:50,fps:60},{playing:3,maxPlayers:6,ping:70,fps:58}],
              badges:[{name:"join",awardedCount:100,pastDayAwardedCount:10,winRatePercentage:50},
                      {name:"deep",awardedCount:25,pastDayAwardedCount:2,winRatePercentage:12}],
              gamePasses:[]};
  const l=deriveLive(rows,snap);
  assert.strictEqual(l.serverCount,2);
  assert.strictEqual(l.serversFull,1);
  assert.strictEqual(l.avgServerFillPct,75);
  assert.strictEqual(l.badgeFunnel[1].shareOfEntry,25);
  assert.strictEqual(l.badgeAwardsPastDay,12);
});
t("no crash on empty history", ()=>{
  assert.deepStrictEqual(deriveLive([],{}),{});
  assert.deepStrictEqual(dailyVisits([]),[]);
});
t("no crash on all-null fields", ()=>{
  const r=[mk("2026-08-26T00:00:00Z",{ccu:null,visits:null,favorites:null,upVotes:null,downVotes:null,ratingPct:null})];
  const l=deriveLive(r,{servers:[],badges:[]});
  assert.strictEqual(l.ccu,null);
  assert.strictEqual(l.serverCount,0);
});
console.log(`\n${n} assertions passed`);
