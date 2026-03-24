import process from 'node:process';
import { Wallet, getAddress } from 'ethers';

const EIP712_TYPES = {
  AuthEnvelope: [
    { name: 'requestId', type: 'string' },
    { name: 'agentId', type: 'string' },
    { name: 'action', type: 'string' },
    { name: 'payloadHash', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'arenaId', type: 'string' },
    { name: 'chainId', type: 'uint256' }
  ]
};

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

(async () => {
  const privateKey = process.env.EIP712_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('Missing EIP712_PRIVATE_KEY');
  }

  const raw = await readStdin();
  if (!raw) {
    throw new Error('Please pipe auth envelope JSON (without signature) to stdin');
  }

  const auth = JSON.parse(raw);
  const wallet = new Wallet(privateKey);

  const domain = {
    name: process.env.EIP712_DOMAIN_NAME || 'EvoHiveArenaAuth',
    version: process.env.EIP712_DOMAIN_VERSION || '1',
    chainId: Number(auth.chainId),
    verifyingContract: process.env.EIP712_VERIFYING_CONTRACT || '0x0000000000000000000000000000000000000000'
  };

  const message = {
    requestId: String(auth.requestId),
    agentId: String(auth.agentId),
    action: String(auth.action),
    payloadHash: String(auth.payloadHash),
    issuedAt: BigInt(auth.issuedAt),
    deadline: BigInt(auth.deadline),
    arenaId: String(auth.arenaId),
    chainId: BigInt(auth.chainId)
  };

  const signature = await wallet.signTypedData(domain, EIP712_TYPES, message);

  process.stdout.write(
    `${JSON.stringify(
      {
        expectedSigner: getAddress(wallet.address),
        signature,
        auth: {
          ...auth,
          signature
        }
      },
      null,
      2
    )}\n`
  );
})().catch((err) => {
  console.error(String(err?.message || err));
  process.exit(1);
});
