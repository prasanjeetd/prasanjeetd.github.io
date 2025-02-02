// Initialize Materialize Sidenav, ScrollSpy, and AOS
document.addEventListener("DOMContentLoaded", function () {
  M.Sidenav.init(document.querySelectorAll(".sidenav"));
  M.ScrollSpy.init(document.querySelectorAll(".scrollspy"), { scrollOffset: 60 });
  AOS.init({ duration: 1000, once: false });
});

// Three.js Setup for 3D Laptop Hover Effect
const container = document.getElementById("laptopContainer");
const width = container.clientWidth;
const height = container.clientHeight;

// Scene, Camera, and Renderer Setup
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x202020);

const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
camera.position.set(0, 2, 6);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(width, height);
container.appendChild(renderer.domElement);

// Lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
directionalLight.position.set(5, 10, 7.5);
scene.add(directionalLight);

// Laptop Model Creation
const laptopGroup = new THREE.Group();

// Shared transparent material for laptop parts
const laptopMaterial = new THREE.MeshStandardMaterial({
  color: 0x555555, // initial gray
  transparent: true,
  opacity: 0.5,
  metalness: 0.5,
  roughness: 0.3,
});

// --- Laptop Base ---
const baseGeometry = new THREE.BoxGeometry(3, 0.1, 2);
const baseMesh = new THREE.Mesh(baseGeometry, laptopMaterial.clone());
laptopGroup.add(baseMesh);

// Add borders to base using edges
const baseEdges = new THREE.EdgesGeometry(baseGeometry);
const baseLine = new THREE.LineSegments(
  baseEdges,
  new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 2 })
);
baseMesh.add(baseLine);

// --- Laptop Screen ---
const screenPivot = new THREE.Group();
screenPivot.position.set(0, 0.05, -1); // hinge position at the back edge of the base
screenPivot.rotation.x = -0.5; // open screen angle

const screenGeometry = new THREE.BoxGeometry(3, 2, 0.1);
const screenMesh = new THREE.Mesh(screenGeometry, laptopMaterial.clone());
screenMesh.position.set(0, 1, 0);
screenPivot.add(screenMesh);

// Add borders to screen
const screenEdges = new THREE.EdgesGeometry(screenGeometry);
const screenLine = new THREE.LineSegments(
  screenEdges,
  new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 2 })
);
screenMesh.add(screenLine);

laptopGroup.add(screenPivot);
scene.add(laptopGroup);

// Interaction Variables
let targetRotationX = 0;
let targetRotationY = 0;
let isHovered = false;

// Update rotation based on mouse movement over container
container.addEventListener("mousemove", (event) => {
  const rect = container.getBoundingClientRect();
  const mouseX = event.clientX - rect.left;
  const mouseY = event.clientY - rect.top;
  const normalizedX = mouseX / rect.width - 0.5;
  const normalizedY = mouseY / rect.height - 0.5;
  const tiltFactor = 0.4;
  targetRotationY = normalizedX * tiltFactor;
  targetRotationX = -normalizedY * tiltFactor;
});

// Change color on mouse enter
container.addEventListener("mouseenter", () => {
  isHovered = true;
  baseMesh.material.color.set(0x007bff);
  screenMesh.material.color.set(0x007bff);
});

// On mouse leave, revert color and reset rotation targets
container.addEventListener("mouseleave", () => {
  isHovered = false;
  baseMesh.material.color.set(0x555555);
  screenMesh.material.color.set(0x555555);
  targetRotationX = 0;
  targetRotationY = 0;
});

// Animation Loop
function animate() {
  requestAnimationFrame(animate);
  const transitionSpeed = isHovered ? 0.1 : 0.3;
  laptopGroup.rotation.x += (targetRotationX - laptopGroup.rotation.x) * transitionSpeed;
  laptopGroup.rotation.y += (targetRotationY - laptopGroup.rotation.y) * transitionSpeed;
  renderer.render(scene, camera);
}
animate();

// Handle Window Resize
window.addEventListener("resize", () => {
  const newWidth = container.clientWidth;
  const newHeight = container.clientHeight;
  camera.aspect = newWidth / newHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(newWidth, newHeight);
});
