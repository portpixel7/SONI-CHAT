const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { server } = require('../server');

let url = process.env.TEST_URL;
let startedLocalServer = false;
const connect = () => new Promise((resolve, reject) => {
  const socket = io(url, { reconnection: false });
  socket.once('connect', () => resolve(socket));
  socket.once('connect_error', reject);
});
const emit = (socket, event, data) => new Promise(resolve => socket.emit(event, data, resolve));
const once = (socket, event) => new Promise(resolve => socket.once(event, resolve));

(async () => {
  if (!url) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
    startedLocalServer = true;
  }
  const alice = await connect();
  const bob = await connect();
  const eve = await connect();
  try {
    assert.equal((await emit(alice, 'join-room', { user: 'Alice', room: '8800', password: 'secret' })).ok, true);
    assert.equal((await emit(eve, 'join-room', { user: 'Eve', room: '8800', password: 'wrong' })).ok, false);
    assert.equal((await emit(bob, 'join-room', { user: 'Bob', room: '8800', password: 'secret' })).ok, true);
    const receivedText = once(bob, 'chat-message');
    assert.equal((await emit(alice, 'chat-message', { text: 'hello' })).ok, true);
    const textMessage = await receivedText;
    assert.equal(textMessage.text, 'hello');
    const seenReceipt = once(alice, 'message-seen');
    bob.emit('message-seen', { messageId: textMessage.messageId });
    assert.equal((await seenReceipt).messageId, textMessage.messageId);
    assert.equal((await emit(bob, 'report-message', { messageId: textMessage.messageId })).ok, true);
    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const receivedImage = once(bob, 'image-message');
    assert.equal((await emit(alice, 'image-message', { image: tinyPng })).ok, true);
    assert.equal((await receivedImage).image, tinyPng);
    const imageOverOldLimit = `data:image/png;base64,${Buffer.alloc(600_000).toString('base64')}`;
    assert.equal((await emit(alice, 'image-message', { image: imageOverOldLimit })).ok, true, 'images over 500 KB should be accepted');
    const imageOverNewLimit = `data:image/png;base64,${Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64')}`;
    assert.equal((await emit(alice, 'image-message', { image: imageOverNewLimit })).ok, false, 'images over 5 MB should be rejected');
    const whatsappAudio = `data:audio/ogg;base64,${Buffer.alloc(1_000).toString('base64')}`;
    const receivedAudio = once(bob, 'audio-message');
    assert.equal((await emit(alice, 'audio-message', { audio: whatsappAudio })).ok, true);
    assert.equal((await receivedAudio).audio, whatsappAudio);
    const oversizedAudio = `data:audio/ogg;base64,${Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64')}`;
    assert.equal((await emit(alice, 'audio-message', { audio: oversizedAudio })).ok, false, 'audio over 10 MB should be rejected');
    const incomingCall = once(bob, 'call-incoming');
    assert.equal((await emit(alice, 'call-user', { target: bob.id })).ok, true);
    assert.equal((await incomingCall).user, 'Alice');
    const relayedSignal = once(bob, 'webrtc-signal');
    assert.equal((await emit(alice, 'webrtc-signal', { target: bob.id, signal: { description: { type: 'offer', sdp: 'test' } } })).ok, true);
    assert.equal((await relayedSignal).signal.description.type, 'offer');
    assert.equal((await emit(eve, 'call-user', { target: bob.id })).ok, false, 'calls cannot cross rooms');
    const spamResults = [];
    for (let index = 0; index < 10; index += 1) spamResults.push(await emit(alice, 'chat-message', { text: `spam-${index}` }));
    assert.ok(spamResults.some(result => !result.ok), 'rate limit should reject rapid messages');
    alice.disconnect();
    const reconnectedAlice = await connect();
    assert.equal((await emit(reconnectedAlice, 'join-room', { user: 'Alice', room: '8800', password: 'secret' })).ok, true);
    reconnectedAlice.disconnect();
    console.log('PASS password, messaging, seen, image, audio, voice-call signaling, reporting, rate-limit and rejoin checks');
  } finally {
    alice.disconnect(); bob.disconnect(); eve.disconnect();
    if (startedLocalServer) await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
