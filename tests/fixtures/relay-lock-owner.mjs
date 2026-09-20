import { RelayLock } from '../../src/workbuddy/lock.ts';
const [dir,mode] = process.argv.slice(2);
const lock = new RelayLock(dir);
await lock.acquire({takeOver:mode==='force',force:mode==='force'});
console.log('READY '+process.pid);
if(mode==='ignore-term')process.on('SIGTERM',()=>{});
else process.on('SIGTERM',async()=>{if(lock.owns())lock.release('test');await lock.closeGate();process.exit(0)});
