type V=number[];
const sub=(a:V,b:V)=>a.map((x,i)=>x-b[i]);
const dot=(a:V,b:V)=>a.reduce((s,x,i)=>s+x*b[i],0);
const cross=(a:V,b:V)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const length2=(a:V)=>dot(a,a);
function pointTriangle(p:V,a:V,b:V,c:V){
 const ab=sub(b,a),ac=sub(c,a),ap=sub(p,a),d1=dot(ab,ap),d2=dot(ac,ap);
 if(d1<=0&&d2<=0)return length2(ap);
 const bp=sub(p,b),d3=dot(ab,bp),d4=dot(ac,bp);if(d3>=0&&d4<=d3)return length2(bp);
 const vc=d1*d4-d3*d2;if(vc<=0&&d1>=0&&d3<=0){const v=d1/(d1-d3);return length2(ap.map((x,i)=>x-v*ab[i]));}
 const cp=sub(p,c),d5=dot(ab,cp),d6=dot(ac,cp);if(d6>=0&&d5<=d6)return length2(cp);
 const vb=d5*d2-d1*d6;if(vb<=0&&d2>=0&&d6<=0){const w=d2/(d2-d6);return length2(ap.map((x,i)=>x-w*ac[i]));}
 const va=d3*d6-d5*d4;if(va<=0&&(d4-d3)>=0&&(d5-d6)>=0){const w=(d4-d3)/((d4-d3)+(d5-d6));return length2(bp.map((x,i)=>x-w*(c[i]-b[i])));}
 const n=cross(ab,ac),s=dot(ap,n);return s*s/Math.max(1e-30,length2(n));
}
function segments(a:V,b:V,c:V,d:V){
 const u=sub(b,a),v=sub(d,c),w=sub(a,c),aa=dot(u,u),bb=dot(u,v),cc=dot(v,v),dd=dot(u,w),ee=dot(v,w);
 let s=0,t=0;const clamp=(x:number)=>Math.max(0,Math.min(1,x));
 if(aa<=1e-24&&cc<=1e-24)return length2(w);
 if(aa<=1e-24)t=clamp(ee/cc);
 else if(cc<=1e-24)s=clamp(-dd/aa);
 else{const den=aa*cc-bb*bb;s=den>1e-24?clamp((bb*ee-cc*dd)/den):0;t=(bb*s+ee)/cc;if(t<0){t=0;s=clamp(-dd/aa);}else if(t>1){t=1;s=clamp((bb-dd)/aa);}}
 return length2(w.map((x,i)=>x+s*u[i]-t*v[i]));
}
/** Exact closest-feature distance, with a separating-axis overlap test. */
export function triangleBoxDistance(points:V[],box:{min:V;max:V}){
 const center=box.min.map((v,i)=>(v+box.max[i])/2),half=box.min.map((v,i)=>(box.max[i]-v)/2);
 const local=points.map(p=>sub(p,center)),edges=[sub(local[1],local[0]),sub(local[2],local[1]),sub(local[0],local[2])];
 const axes=[[1,0,0],[0,1,0],[0,0,1],cross(edges[0],edges[1]),...edges.flatMap(e=>[[0,e[2],-e[1]],[-e[2],0,e[0]],[e[1],-e[0],0]])];
 const separated=axes.some(axis=>{const projection=local.map(p=>dot(p,axis)),r=axis.reduce((s,v,i)=>s+Math.abs(v)*half[i],0);return Math.min(...projection)>r+1e-12||Math.max(...projection)<-r-1e-12;});
 if(!separated)return 0;
 let distance=Math.min(...points.map(p=>p.reduce((s,v,i)=>s+Math.max(box.min[i]-v,0,v-box.max[i])**2,0)));
 const corners=Array.from({length:8},(_,id)=>[0,1,2].map(axis=>id&(1<<axis)?box.max[axis]:box.min[axis]));
 for(const p of corners)distance=Math.min(distance,pointTriangle(p,...points as [V,V,V]));
 for(let i=0;i<8;i++)for(let axis=0;axis<3;axis++)if(!(i&(1<<axis)))for(let edge=0;edge<3;edge++)distance=Math.min(distance,segments(corners[i],corners[i|(1<<axis)],points[edge],points[(edge+1)%3]));
 return Math.sqrt(distance);
}
