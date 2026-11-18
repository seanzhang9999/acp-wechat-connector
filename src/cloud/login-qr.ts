import {createRequire} from 'node:module';
import {deflateSync} from 'node:zlib';
const require=createRequire(import.meta.url);
const QRCode=require('qrcode-terminal/vendor/QRCode');

function chunk(type:string,data:Buffer):Buffer {
 const body=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;
 for(const byte of body){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
 const length=Buffer.alloc(4);length.writeUInt32BE(data.length);
 const checksum=Buffer.alloc(4);checksum.writeUInt32BE((crc^0xffffffff)>>>0);
 return Buffer.concat([length,body,checksum]);
}
/** Lossless monochrome PNG, integer scaling and four-module quiet zone. No remote QR service. */
export function loginQrPng(url:string):Buffer {
 const qr=new QRCode(-1,1);qr.addData(url);qr.make();
 const modules=qr.getModuleCount(),scale=10,size=(modules+8)*scale;
 const pixels=Buffer.alloc((size+1)*size,255);
 for(let y=0;y<size;y++){
  pixels[y*(size+1)]=0;
  for(let x=0;x<size;x++){
   const row=Math.floor(y/scale)-4,col=Math.floor(x/scale)-4;
   if(row>=0&&col>=0&&row<modules&&col<modules&&qr.isDark(row,col))pixels[y*(size+1)+x+1]=0;
  }
 }
 const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
