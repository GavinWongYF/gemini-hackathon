import{r,am as X,j as e,F as T,y as G}from"./index-CdInbUyF.js";import{u as W,a as R,C as $,b as J}from"./Gltf-D7kozQ1U.js";import{_ as Q,P as ee}from"./PerspectiveCamera-BTnuLAT2.js";import{ax as _,t as te,h as re,ay as ae,C as se,f as z,a7 as ie,V as ne,s as oe,ad as ue,o as le}from"./DRACOLoader-C_jVEUbr.js";import{v as d,w as h,u as ce}from"./buildStadium-BtFx_Xjy.js";const fe={uniforms:{tDiffuse:{value:null},h:{value:1/512}},vertexShader:`
      varying vec2 vUv;

      void main() {

        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

      }
  `,fragmentShader:`
    uniform sampler2D tDiffuse;
    uniform float h;

    varying vec2 vUv;

    void main() {

    	vec4 sum = vec4( 0.0 );

    	sum += texture2D( tDiffuse, vec2( vUv.x - 4.0 * h, vUv.y ) ) * 0.051;
    	sum += texture2D( tDiffuse, vec2( vUv.x - 3.0 * h, vUv.y ) ) * 0.0918;
    	sum += texture2D( tDiffuse, vec2( vUv.x - 2.0 * h, vUv.y ) ) * 0.12245;
    	sum += texture2D( tDiffuse, vec2( vUv.x - 1.0 * h, vUv.y ) ) * 0.1531;
    	sum += texture2D( tDiffuse, vec2( vUv.x, vUv.y ) ) * 0.1633;
    	sum += texture2D( tDiffuse, vec2( vUv.x + 1.0 * h, vUv.y ) ) * 0.1531;
    	sum += texture2D( tDiffuse, vec2( vUv.x + 2.0 * h, vUv.y ) ) * 0.12245;
    	sum += texture2D( tDiffuse, vec2( vUv.x + 3.0 * h, vUv.y ) ) * 0.0918;
    	sum += texture2D( tDiffuse, vec2( vUv.x + 4.0 * h, vUv.y ) ) * 0.051;

    	gl_FragColor = sum;

    }
  `},ve={uniforms:{tDiffuse:{value:null},v:{value:1/512}},vertexShader:`
    varying vec2 vUv;

    void main() {

      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

    }
  `,fragmentShader:`

  uniform sampler2D tDiffuse;
  uniform float v;

  varying vec2 vUv;

  void main() {

    vec4 sum = vec4( 0.0 );

    sum += texture2D( tDiffuse, vec2( vUv.x, vUv.y - 4.0 * v ) ) * 0.051;
    sum += texture2D( tDiffuse, vec2( vUv.x, vUv.y - 3.0 * v ) ) * 0.0918;
    sum += texture2D( tDiffuse, vec2( vUv.x, vUv.y - 2.0 * v ) ) * 0.12245;
    sum += texture2D( tDiffuse, vec2( vUv.x, vUv.y - 1.0 * v ) ) * 0.1531;
    sum += texture2D( tDiffuse, vec2( vUv.x, vUv.y ) ) * 0.1633;
    sum += texture2D( tDiffuse, vec2( vUv.x, vUv.y + 1.0 * v ) ) * 0.1531;
    sum += texture2D( tDiffuse, vec2( vUv.x, vUv.y + 2.0 * v ) ) * 0.12245;
    sum += texture2D( tDiffuse, vec2( vUv.x, vUv.y + 3.0 * v ) ) * 0.0918;
    sum += texture2D( tDiffuse, vec2( vUv.x, vUv.y + 4.0 * v ) ) * 0.051;

    gl_FragColor = sum;

  }
  `},me=r.forwardRef(({scale:t=10,frames:s=1/0,opacity:l=1,width:n=1,height:o=1,blur:f=1,near:u=0,far:a=10,resolution:i=512,smooth:p=!0,color:b="#000000",depthWrite:S=!1,renderOrder:N,...Y},Z)=>{const j=r.useRef(null),v=W(c=>c.scene),m=W(c=>c.gl),y=r.useRef(null);n=n*(Array.isArray(t)?t[0]:t||1),o=o*(Array.isArray(t)?t[1]:t||1);const[M,q,H,x,D,w,I]=r.useMemo(()=>{const c=new _(i,i),F=new _(i,i);F.texture.generateMipmaps=c.texture.generateMipmaps=!1;const O=new te(n,o).rotateX(Math.PI/2),K=new re(O),U=new ae;U.depthTest=U.depthWrite=!1,U.onBeforeCompile=g=>{g.uniforms={...g.uniforms,ucolor:{value:new se(b)}},g.fragmentShader=g.fragmentShader.replace("void main() {",`uniform vec3 ucolor;
           void main() {
          `),g.fragmentShader=g.fragmentShader.replace("vec4( vec3( 1.0 - fragCoordZ ), opacity );","vec4( ucolor * fragCoordZ * 2.0, ( 1.0 - fragCoordZ ) * 1.0 );")};const A=new z(fe),B=new z(ve);return B.depthTest=A.depthTest=!1,[c,O,U,K,A,B,F]},[i,n,o,t,b]),k=c=>{x.visible=!0,x.material=D,D.uniforms.tDiffuse.value=M.texture,D.uniforms.h.value=c*1/256,m.setRenderTarget(I),m.render(x,y.current),x.material=w,w.uniforms.tDiffuse.value=I.texture,w.uniforms.v.value=c*1/256,m.setRenderTarget(M),m.render(x,y.current),x.visible=!1};let E=0,L,P;return R(()=>{y.current&&(s===1/0||E<s)&&(E++,L=v.background,P=v.overrideMaterial,j.current.visible=!1,v.background=null,v.overrideMaterial=H,m.setRenderTarget(M),m.render(v,y.current),k(f),p&&k(f*.4),m.setRenderTarget(null),j.current.visible=!0,v.overrideMaterial=P,v.background=L)}),r.useImperativeHandle(Z,()=>j.current,[]),r.createElement("group",Q({"rotation-x":Math.PI/2},Y,{ref:j}),r.createElement("mesh",{renderOrder:N,geometry:q,scale:[1,-1,1],rotation:[-Math.PI/2,0,0]},r.createElement("meshBasicMaterial",{transparent:!0,map:M.texture,opacity:l,depthWrite:S})),r.createElement("orthographicCamera",{ref:y,args:[-n/2,n/2,o/2,-o/2,u,a]}))}),C="#c4ff36";function de({id:t,onClipFinished:s}){const{scene:l,animations:n}=J(`/models/win_celebration_${t}.glb`),o=r.useRef(null),f=r.useRef(!1);return r.useEffect(()=>{const u=()=>{f.current||(f.current=!0,s())};if(!n.length){const S=window.setTimeout(u,2500);return()=>clearTimeout(S)}const a=new ue(l);o.current=a;const i=n[0],p=a.clipAction(i);p.reset(),p.setLoop(le,1),p.clampWhenFinished=!0,p.play(),a.addEventListener("finished",u);const b=window.setTimeout(u,i.duration*1e3+1500);return()=>{a.removeEventListener("finished",u),a.stopAllAction(),clearTimeout(b)}},[n,l,s]),r.useEffect(()=>{l.traverse(u=>{const a=u;a.isMesh&&(a.castShadow=!1,a.receiveShadow=!1)})},[l]),R((u,a)=>{o.current&&o.current.update(a)}),e.jsx("primitive",{object:l,scale:1.4,position:[0,0,6],rotation:[0,Math.PI,0]})}function pe(){const t=r.useMemo(()=>new oe({color:"#ffffff"}),[]);return e.jsxs("group",{children:[e.jsxs("mesh",{rotation:[-Math.PI/2,0,0],position:[0,-.001,0],receiveShadow:!0,children:[e.jsx("planeGeometry",{args:[d+8,h+8]}),e.jsx("meshStandardMaterial",{color:"#1d4f8a",roughness:.9,metalness:0})]}),e.jsxs("mesh",{rotation:[-Math.PI/2,0,0],position:[0,0,0],receiveShadow:!0,children:[e.jsx("planeGeometry",{args:[d,h]}),e.jsx("meshStandardMaterial",{color:"#2c70b3",roughness:.85,metalness:0})]}),e.jsx("mesh",{position:[d/2-.05,.01,0],material:t,children:e.jsx("boxGeometry",{args:[.08,.005,h]})}),e.jsx("mesh",{position:[-d/2+.05,.01,0],material:t,children:e.jsx("boxGeometry",{args:[.08,.005,h]})}),e.jsx("mesh",{position:[0,.01,h/2-.05],material:t,children:e.jsx("boxGeometry",{args:[d,.005,.08]})}),e.jsx("mesh",{position:[0,.01,-h/2+.05],material:t,children:e.jsx("boxGeometry",{args:[d,.005,.08]})}),e.jsx("mesh",{position:[0,.01,0],material:t,children:e.jsx("boxGeometry",{args:[d,.005,.06]})})]})}function xe(){const t=r.useMemo(()=>{try{return ce().group}catch(s){return console.warn("[WinCelebrationStage] buildStadium failed:",s),null}},[]);return t?e.jsx("primitive",{object:t}):null}function Ue({onDone:t}){const s=X(a=>a.equippedWinAnim),[l,n]=r.useState(!1),[o,f]=r.useState(!1);if(r.useEffect(()=>{const a=window.setTimeout(t,3e4);return()=>clearTimeout(a)},[t]),r.useEffect(()=>{s||t()},[s,t]),!s)return null;const u=!l||!o;return e.jsxs("div",{style:{position:"fixed",inset:0,zIndex:700,background:"#02040a",fontFamily:T,animation:"wcsFadeIn 0.4s ease-out both"},role:"dialog","aria-label":"Victory pose preview",children:[e.jsx("style",{children:`
        @keyframes wcsFadeIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes wcsPulse { 0%,100% { opacity: 0.55 } 50% { opacity: 1 } }
      `}),e.jsxs("div",{style:{position:"absolute",top:28,left:0,right:0,textAlign:"center",zIndex:3,pointerEvents:"none"},children:[e.jsx("div",{style:{fontFamily:G,fontSize:12,letterSpacing:5,fontWeight:800,color:C,opacity:.95,marginBottom:6,textShadow:"0 0 12px rgba(196,255,54,0.4)"},children:"◆ YOUR VICTORY POSE ◆"}),e.jsx("div",{style:{fontFamily:T,fontSize:12,color:"rgba(255,255,255,0.55)"},children:"This plays after every match you win."})]}),e.jsx("button",{onClick:t,"aria-label":"Skip celebration",style:{position:"absolute",top:28,right:28,zIndex:4,background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.18)",color:"rgba(255,255,255,0.75)",padding:"9px 22px",borderRadius:999,fontFamily:T,fontSize:12,fontWeight:700,letterSpacing:"0.18em",textTransform:"uppercase",cursor:"pointer",transition:"background 0.15s, color 0.15s"},onMouseOver:a=>{const i=a.currentTarget;i.style.background="rgba(255,255,255,0.10)",i.style.color="#fff"},onMouseOut:a=>{const i=a.currentTarget;i.style.background="rgba(255,255,255,0.05)",i.style.color="rgba(255,255,255,0.75)"},children:"Skip →"}),u&&e.jsx("div",{style:{position:"absolute",inset:0,zIndex:2,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",color:C,pointerEvents:"none"},children:e.jsx("div",{style:{fontFamily:G,fontSize:22,letterSpacing:6,fontWeight:800,animation:"wcsPulse 1.4s ease-in-out infinite"},children:"WALKING ONTO COURT…"})}),e.jsxs($,{dpr:[1,1.25],shadows:!1,gl:{powerPreference:"high-performance",antialias:!1,toneMapping:ie,toneMappingExposure:.9},style:{width:"100%",height:"100%",display:"block"},onCreated:()=>n(!0),children:[e.jsx(ee,{makeDefault:!0,position:[0,2.1,-1.2],fov:42}),e.jsx(ge,{}),e.jsx("color",{attach:"background",args:["#03060e"]}),e.jsx("fog",{attach:"fog",args:["#06091a",22,95]}),e.jsx("ambientLight",{intensity:.22}),e.jsx("hemisphereLight",{args:["#ffffff","#0c1326",.32]}),e.jsx("spotLight",{position:[0,8,-4],intensity:4.5,angle:.55,penumbra:.45,color:"#fff5e0","target-position":[0,1,6]}),e.jsx("spotLight",{position:[-3,6,10],intensity:2,angle:.7,penumbra:.5,color:C,"target-position":[0,1.2,6]}),e.jsx("spotLight",{position:[6,5,4],intensity:1.2,angle:.8,penumbra:.7,color:"#9ed4ff","target-position":[0,1,6]}),e.jsx(pe,{}),e.jsx(xe,{}),e.jsxs(r.Suspense,{fallback:e.jsx(V,{onLoaded:()=>f(!0),loaded:!1}),children:[e.jsx(de,{id:s,onClipFinished:t}),e.jsx(V,{onLoaded:()=>f(!0),loaded:!0})]}),e.jsx(me,{position:[0,.005,6],opacity:.55,scale:5,blur:2.5,far:1.6,color:"#000"})]})]})}function ge(){const t=r.useMemo(()=>new ne(0,1.35,6),[]);return R(({camera:s})=>{s.lookAt(t)}),null}function V({onLoaded:t,loaded:s}){return r.useEffect(()=>{s&&t()},[s,t]),null}export{Ue as default};
