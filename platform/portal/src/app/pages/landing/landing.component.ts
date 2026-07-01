import { Component, OnInit, OnDestroy, AfterViewInit, Inject, PLATFORM_ID } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { RouterModule } from '@angular/router';

@Component({
  selector: 'app-landing',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './landing.component.html',
  styleUrl: './landing.component.css'
})
export class LandingComponent implements OnInit, AfterViewInit, OnDestroy {
  currentTypedText = '';
  private texts = ["React Developers", "DevOps Engineers", "Node.js Backends", "You"];
  private typeIndex = 0;
  private charIndex = 0;
  private isDeleting = false;
  private typingTimeout: any;

  constructor(@Inject(PLATFORM_ID) private platformId: Object) {}

  ngOnInit() {
    if (isPlatformBrowser(this.platformId)) {
      this.startTypingEffect();
    }
  }

  ngAfterViewInit() {
    if (isPlatformBrowser(this.platformId)) {
      // Initialize Three.js after view is ready
      setTimeout(() => this.initThreeJs(), 100);
    }
  }

  startTypingEffect() {
    const type = () => {
      const current = this.texts[this.typeIndex];
      if (this.isDeleting) {
        this.currentTypedText = current.substring(0, this.charIndex - 1);
        this.charIndex--;
      } else {
        this.currentTypedText = current.substring(0, this.charIndex + 1);
        this.charIndex++;
      }
      
      if (!this.isDeleting && this.charIndex === current.length) {
        this.typingTimeout = setTimeout(() => { this.isDeleting = true; type(); }, 1500);
        return;
      } else if (this.isDeleting && this.charIndex === 0) {
        this.isDeleting = false;
        this.typeIndex = (this.typeIndex + 1) % this.texts.length;
      }
      
      this.typingTimeout = setTimeout(type, this.isDeleting ? 50 : 150);
    };
    this.typingTimeout = setTimeout(type, 1000);
  }

  initThreeJs() {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r134/three.min.js';
    script.onload = () => {
      const THREE = (window as any).THREE;
      if (!THREE) return;
      
      const canvas = document.getElementById('heroCanvas') as HTMLCanvasElement;
      if (!canvas) return;

      const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
      renderer.setSize(window.innerWidth, window.innerHeight);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
      camera.position.z = 5;

      const geometry = new THREE.IcosahedronGeometry(2, 0);
      const material = new THREE.MeshBasicMaterial({ 
        color: 0x2d2d2d, 
        wireframe: true,
        transparent: true,
        opacity: 0.3
      });
      const mesh = new THREE.Mesh(geometry, material);
      scene.add(mesh);

      const animate = () => {
        requestAnimationFrame(animate);
        mesh.rotation.x += 0.005;
        mesh.rotation.y += 0.005;
        renderer.render(scene, camera);
      };
      animate();

      window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
      });
    };
    document.head.appendChild(script);
  }

  ngOnDestroy() {
    if (this.typingTimeout) {
      clearTimeout(this.typingTimeout);
    }
  }
}
