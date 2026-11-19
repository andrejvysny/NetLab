import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lab } from '../../src/engine/lab.ts';
import { installCli, startSession, execLine } from '../../src/engine/cli/index.ts';
import { addDevice, createWorld } from '../../src/engine/world.ts';

test('controller diagnostics require privileged EXEC without blocking normal user link verification',()=>{
  installCli(); const w=createWorld();const r=addDevice(w,{id:'R',model:'isr4331',label:'R',x:0,y:0});assert.ok(r.kind==='router');r.runtime.setupDialogDone=true;
  const {session}=startSession(w,'R','console');assert.equal(session.mode,'user');
  assert.equal(execLine(w,session,'show ip interface brief').status,'ok');
  assert.notEqual(execLine(w,session,'show controllers serial 0/1/0').status,'ok');
  execLine(w,session,'enable');assert.equal(execLine(w,session,'sh controllers se0/1/0').status,'ok');
});
test('saved practice report records its rubric and classifier at grading time, independently of later browser defaults',()=>{
  const l=new Lab({storage:null}); assert.ok(l.startScenario('case-study-2026','free',{seed:0}).ok);
  const first=l.check();assert.deepEqual(first.practiceBasis,{revision:2,qos:'course'});
  l.updateSettings({qosClassifiesInnerHeader:false});assert.equal(l.getState().report,null);
  const second=l.check();assert.deepEqual(second.practiceBasis,{revision:2,qos:'after-encryption'});
  const imported=new Lab({storage:null});assert.ok(imported.importLab(l.exportLab()).ok);
  assert.deepEqual(imported.getState().report?.practiceBasis,second.practiceBasis);
});
