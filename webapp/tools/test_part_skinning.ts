// A part's authored affine map must survive skinning and a transformed parent.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-part-skinning-'));
try {
 const file=path.join(tmp,'test.mjs');
 await build({stdin:{contents:"export {PartSkinnedMesh} from './src/viewers/part-skinned-mesh.ts'; export {SpawnAnimComposite} from './src/viewers/world/spawn-anim.ts'; export * from './vendor/three.module.js';",resolveDir:path.resolve(import.meta.dirname,'..')},bundle:true,platform:'node',format:'esm',outfile:file});
 const T=await import(pathToFileURL(file).href);
 const scene=new T.Group(),frame=new T.Group(),bone=new T.Bone();
 scene.add(frame);frame.add(bone);scene.rotation.x=-Math.PI/2;scene.scale.set(.1,-.1,.1);
 frame.position.set(50,70,20);frame.rotation.z=.6;
 const skeleton=new T.Skeleton([bone],[new T.Matrix4()]);
 const geo=new T.BufferGeometry();
 geo.setAttribute('position',new T.Float32BufferAttribute([2,3,5],3));
 geo.setAttribute('skinIndex',new T.Uint16BufferAttribute([0,0,0,0],4));
 geo.setAttribute('skinWeight',new T.Float32BufferAttribute([1,0,0,0],4));
 const locals=[new T.Matrix4(),new T.Matrix4().makeTranslation(300,-70,90),new T.Matrix4().set(-1,.2,0,40,0,2,.1,60,0,0,.5,-10,0,0,0,1)];
 let checks=0;
 for(const local of locals){
  const mesh=new T.PartSkinnedMesh(geo,new T.MeshBasicMaterial(),frame);
  mesh.matrixAutoUpdate=false;mesh.matrix.copy(local);frame.add(mesh);
  mesh.bind(skeleton,new T.Matrix4());
  for(const angle of [0,.7]){
   bone.rotation.z=angle;scene.updateMatrixWorld(true);skeleton.update();
   const actual=mesh.getVertexPosition(0,new T.Vector3()).applyMatrix4(mesh.matrixWorld);
   const expected=new T.Vector3(2,3,5).applyMatrix4(bone.matrix).applyMatrix4(local).applyMatrix4(frame.matrixWorld);
   assert(actual.distanceTo(expected)<1e-8,JSON.stringify({angle,local:local.elements,actual,expected}));checks++;
  }
  mesh.removeFromParent();
 }
 const rig={roots:[new T.Bone()],skeleton:null};rig.skeleton=new T.Skeleton(rig.roots,[new T.Matrix4()]);
 const composite=new T.SpawnAnimComposite({world:{_meshGeometry:async()=>geo,_material:async()=>new T.MeshBasicMaterial()},rig});
 scene.add(composite.group);
 await composite.loadParts({parts:[{mesh:1},{mesh:1},{mesh:2}],shard:{},skinnedSet:new Set([1])});
 composite.setBaseMatrix(new T.Matrix4().makeTranslation(50,80,20));composite.setPartMatrices(locals);
 for(const angle of [0,.3]){
  rig.roots[0].rotation.z=angle;scene.updateMatrixWorld(true);rig.skeleton.update();
  for(let i=0;i<3;i++){
   const mesh=composite._meshes[i],actual=mesh.getVertexPosition(0,new T.Vector3()).applyMatrix4(mesh.matrixWorld);
   const expected=new T.Vector3(2,3,5);if(i<2)expected.applyMatrix4(rig.roots[0].matrix);
   expected.applyMatrix4(locals[i]).applyMatrix4(composite.group.matrixWorld);
   assert(actual.distanceTo(expected)<1e-8);checks++;
  }
 }
 composite.dispose();
 console.log(`${checks} rest/animated affine part checks passed`);
}finally{await rm(tmp,{recursive:true,force:true});}
