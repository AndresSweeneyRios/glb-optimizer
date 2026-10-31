import * as THREE from 'three';
import {optimizerAtlasPlugin} from '/runtime/three-atlas.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
const status = document.querySelector('#status');
const views = [];
let ceilings = false;
const draco = new DRACOLoader().setDecoderPath('/three/examples/jsm/libs/draco/gltf/');
const ktxLoaders = [];
const report = await fetch('/report.json').then(r=>r.json());
const formatBytes = bytes => `${(bytes/1e6).toFixed(2)} MB`;
const sourceSize = await fetch('/original.glb',{method:'HEAD'}).then(r=>Number(r.headers.get('content-length')));
document.querySelector('main section:first-child label').textContent = `Original · ${formatBytes(sourceSize)} · ${report.before.primitives} batches`;
document.querySelector('main section:last-child label').textContent = `Optimized · ${formatBytes(report.bytes)} · −${((1-report.bytes/sourceSize)*100).toFixed(1)}% · ${report.after.primitives} batches · ${report.after.materials} materials`;
function render() { for (const v of views) v.renderer.render(v.scene, v.camera); }
function resize() {
  for (const v of views) {
    const {width,height} = v.canvas.getBoundingClientRect();
    v.renderer.setSize(width, height, false);
    v.camera.aspect = width/height;
    v.camera.updateProjectionMatrix();
  }
  render();
}
function sync(source) {
  for (const v of views) if (v !== source) {
    v.camera.position.copy(source.camera.position);
    v.camera.quaternion.copy(source.camera.quaternion);
    v.controls.target.copy(source.controls.target);
  }
  render();
}
try {
  const hdr = await new HDRLoader().loadAsync('/environment.hdr');
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  for (const [id, url] of [['original', '/original.glb'], ['optimized', '/optimized.glb']]) {
    const canvas = document.getElementById(id);
    const renderer = new THREE.WebGLRenderer({canvas,antialias:true});
    renderer.setPixelRatio(Math.min(devicePixelRatio,2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environment = pmrem.fromEquirectangular(hdr);
    pmrem.dispose();
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#111318');
    scene.environment = environment.texture;
    const light = new THREE.DirectionalLight(0xaaaaff, 1);
    light.position.set(0,5,0); scene.add(light);
    const camera = new THREE.PerspectiveCamera(42,1,0.01,150);
    const controls = new OrbitControls(camera,canvas);
    const view = {canvas,renderer,scene,camera,controls,model:null};
    views.push(view);
    controls.addEventListener('change', () => sync(view));
    const ktx = new KTX2Loader().setTranscoderPath('/three/examples/jsm/libs/basis/').detectSupport(renderer);
    ktxLoaders.push(ktx);
    const loader = new GLTFLoader().setDRACOLoader(draco).setKTX2Loader(ktx).register(optimizerAtlasPlugin);
    const gltf = await loader.loadAsync(url);
    const {scene:model} = gltf;
    view.atlas=gltf.userData.optimizerAtlas;
    view.model = model;
    model.traverse(object => {
      if (object.isMesh) Object.assign(object.userData, object.geometry.userData);
      if (object.userData.poolExportVisible === false) object.visible = false;
      if (object.name === 'Ceiling' || object.userData.optimizerCeiling) { object.userData.previewVisible = object.visible; object.visible = false; }
    });
    scene.add(model);
  }
  hdr.dispose(); draco.dispose(); for (const ktx of ktxLoaders) ktx.dispose();
  function reset() {
    const surface = views[0].model.getObjectByName('surface') ?? views[0].model;
    const box = new THREE.Box3().setFromObject(surface);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x,size.z,1);
    for (const v of views) {
      v.controls.target.copy(center);
      v.camera.position.copy(center).add(new THREE.Vector3(radius*1.1,radius*0.95,radius*1.1));
      v.camera.lookAt(center);
      v.controls.update();
    }
    resize();
  }
  document.querySelector('#reset').onclick = reset;
  document.querySelector('#ceiling').onclick = event => {
    ceilings = !ceilings;
    for (const v of views) v.model.traverse(object => { if (object.name === 'Ceiling' || object.userData.optimizerCeiling) object.visible = ceilings && object.userData.previewVisible; });
    event.target.textContent = ceilings ? 'Hide ceiling' : 'Show ceiling'; render();
  };
  new ResizeObserver(resize).observe(document.querySelector('main'));
  reset();
  status.textContent = 'Both models loaded';
  window.preview = {views, render};
} catch (error) { status.textContent = String(error); console.error(error); }
