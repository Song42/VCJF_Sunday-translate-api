/** Local signal processing, not an AI model. Quiet packets do not reset speech silence. */
export class VoiceActivityDetector {
  private noiseRms = 60;
  speech(pcm: Buffer): boolean {
    if (!pcm.length || pcm.length % 2) return false;
    let squared = 0;
    for (let offset = 0; offset < pcm.length; offset += 2) squared += pcm.readInt16LE(offset) ** 2;
    const rms = Math.sqrt(squared / (pcm.length / 2));
    const voiced = rms >= Math.max(180, this.noiseRms * 3);
    if (!voiced) this.noiseRms = this.noiseRms * 0.98 + Math.min(rms, 180) * 0.02;
    return voiced;
  }
}
