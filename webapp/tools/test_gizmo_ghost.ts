// Editor gizmos: every marker batch gets a faint copy drawn over everything (markers under water, in walls or below
// the floor still show where they are); the copy follows the marker and is never picked.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-gizmo-ghost-'));
try {
 const file=path.join(tmp,'scene.mjs');
 await build({stdin:{contents:"export {addGizmoGhost, gizmoMaterial, GIZMO_SWATCH} from './src/viewers/world/scene.ts'; export * as THREE from 'three';",resolveDir:path.resolve(import.meta.dirname,'..'),loader:'ts'},
  bundle:true,platform:'node',format:'esm',outfile:file,logLevel:'error'});
 const {addGizmoGhost,gizmoMaterial,THREE}=await import(pathToFileURL(file).href);
 const geometry=new THREE.BoxGeometry(1,1,1);
 const marker=new THREE.InstancedMesh(geometry,gizmoMaterial('models'),3);
 for(let i=0;i<3;i++)marker.setMatrixAt(i,new THREE.Matrix4().makeTranslation(i*10,0,0));
 marker.computeBoundingSphere();
 const ghost=addGizmoGhost(marker);
 assert.equal(ghost.parent,marker,'the copy is the marker\'s child (shown and hidden with it)');
 assert.equal(ghost.instanceMatrix,marker.instanceMatrix,'the copy shares the marker\'s placements');
 assert.equal(ghost.count,marker.count);
 assert.equal(ghost.geometry,marker.geometry);
 assert.equal(ghost.material.depthTest,false,'the copy is drawn over everything');
 assert.equal(ghost.material.depthWrite,false);
 assert.ok(ghost.material.opacity<marker.material.opacity,'the copy is fainter than the marker');
 assert.equal(marker.material.depthTest,true,'the marker keeps its depth (solid where seen)');
 assert.ok(ghost.renderOrder>marker.renderOrder,'the copy draws after everything else');
 const ray=new THREE.Raycaster(new THREE.Vector3(0,0,10),new THREE.Vector3(0,0,-1));
 const hits:any[]=[];ghost.raycast(ray,hits);
 assert.equal(hits.length,0,'the copy is never picked');
 const marked:any[]=[];marker.raycast(ray,marked);
 assert.ok(marked.length>0,'the marker itself still is');
 console.log('Gizmo copies: drawn over everything, faint, following their marker, never picked');
} finally { await rm(tmp,{recursive:true,force:true}); }
