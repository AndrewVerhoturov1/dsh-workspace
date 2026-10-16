import { useEffect, useState } from 'react';
import { CanvasTexture, SRGBColorSpace } from 'three';

interface LabelImage {
  texture: CanvasTexture;
  aspect: number;
}

/** Native billboard: no secondary React DOM root or imperative DOM removal. */
export function SceneLabel({
  text, position, height = 0.11,
}: { text: string; position: [number, number, number]; height?: number }): React.JSX.Element | null {
  const [image, setImage] = useState<LabelImage | null>(null);
  useEffect(() => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.font = 'bold 22px monospace';
    canvas.width = Math.ceil(ctx.measureText(text).width) + 18;
    canvas.height = 38;
    ctx.fillStyle = '#29251de8';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#dab87a';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
    ctx.font = 'bold 22px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff1d3';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    setImage({ texture, aspect: canvas.width / canvas.height });
    // Allocate/dispose only in committed effects, including StrictMode replay.
    return () => texture.dispose();
  }, [text]);
  if (!image) return null;
  return (
    <sprite position={position} scale={[height * image.aspect, height, 1]}
      raycast={() => {}} renderOrder={10}>
      <spriteMaterial map={image.texture} transparent depthTest={false} depthWrite={false} toneMapped={false} />
    </sprite>
  );
}
