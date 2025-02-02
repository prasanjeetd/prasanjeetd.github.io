// Initialize Materialize Sidenav, ScrollSpy, and AOS
document.addEventListener('DOMContentLoaded', function() {
  M.Sidenav.init(document.querySelectorAll('.sidenav'));
  M.ScrollSpy.init(document.querySelectorAll('.scrollspy'), { scrollOffset: 60 });
  AOS.init({ duration: 1000, once: false });
});

// Three.js Setup for Hero Section 3D Object (Technician)
const canvas = document.getElementById('hero-canvas');
const renderer = new THREE.WebGLRenderer({ antialias: true, canvas: canvas, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a237e);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 1.5, 3);

// Lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);
const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
directionalLight.position.set(5, 10, 7.5);
scene.add(directionalLight);

// Load Technician 3D Model (Replace 'technician.glb' with your actual model file)
const loader = new THREE.GLTFLoader();
loader.load('technician.glb', function(gltf) {
  const model = gltf.scene;
  model.scale.set(0.5, 0.5, 0.5);
  model.position.set(0, -0.5, 0);
  scene.add(model);
}, undefined, function(error) {
  console.error('Error loading the 3D model:', error);
  // Fallback: Create a simple cube
  const geometry = new THREE.BoxGeometry();
  const material = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
  const cube = new THREE.Mesh(geometry, material);
  scene.add(cube);
});

// Animation loop for the 3D scene
function animate() {
  requestAnimationFrame(animate);
  scene.rotation.y += 0.005;
  renderer.render(scene, camera);
}
animate();

// Update canvas size and camera aspect on window resize
window.addEventListener('resize', function() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
});
