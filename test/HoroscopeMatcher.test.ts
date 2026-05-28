import hre from 'hardhat';
import { expect } from 'chai';
import { CofheClient, Encryptable, FheTypes } from '@cofhe/sdk';
import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

const highMatch = [3, 12, 6, 1, 8, 8, 10, 4, 0, 5, 5];
const lowMatch = [9, 2, 1, 7, 3, 11, 6, 8, 4, 2, 10];

async function encryptedChart(cofheClient: CofheClient, values: number[]) {
  const encrypted = await cofheClient
    .encryptInputs(values.map((value) => Encryptable.uint8(BigInt(value))))
    .execute();

  return {
    moonSign: encrypted[0],
    nakshatra: encrypted[1],
    ascSign: encrypted[2],
    sunSign: encrypted[3],
    venusSign: encrypted[4],
    marsSign: encrypted[5],
    jupiterSign: encrypted[6],
    saturnSign: encrypted[7],
    seventhHouseSign: encrypted[8],
    venusHouse: encrypted[9],
    marsHouse: encrypted[10],
  };
}

describe('HoroscopeMatcher', () => {
  let aliceClient: CofheClient;
  let bobClient: CofheClient;
  let caraClient: CofheClient;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let cara: HardhatEthersSigner;

  before(async () => {
    [alice, bob, cara] = await hre.ethers.getSigners();
    aliceClient = await hre.cofhe.createClientWithBatteries(alice);
    bobClient = await hre.cofhe.createClientWithBatteries(bob);
    caraClient = await hre.cofhe.createClientWithBatteries(cara);
  });

  async function deployMatcher() {
    const Factory = await hre.ethers.getContractFactory('HoroscopeMatcher');
    return Factory.deploy();
  }

  it('stores public profile data while keeping chart data encrypted', async () => {
    const matcher = await deployMatcher();
    const chart = await encryptedChart(aliceClient, highMatch);

    await (await matcher.connect(alice).saveProfile('Anika', '@anika_fhe', '#1df8a4', chart)).wait();

    const profile = await matcher.profiles(alice.address);
    expect(profile.displayName).to.equal('Anika');
    expect(profile.xHandle).to.equal('@anika_fhe');
    expect(profile.version).to.equal(1n);
    expect(await matcher.hasEncryptedChart(alice.address)).to.equal(true);
    expect(await matcher.memberCount()).to.equal(1n);
  });

  it('rejects a second profile for the same wallet', async () => {
    const matcher = await deployMatcher();
    const firstChart = await encryptedChart(aliceClient, highMatch);
    const updatedChart = await encryptedChart(aliceClient, lowMatch);

    await (await matcher.connect(alice).saveProfile('Anika', '@anika_fhe', '#1df8a4', firstChart)).wait();
    await expect(
      matcher.connect(alice).saveProfile('Anika Rao', '@anika_sealed', '#38d5ff', updatedChart),
    ).to.be.revertedWith('PROFILE_ALREADY_EXISTS');

    const profile = await matcher.profiles(alice.address);
    expect(profile.displayName).to.equal('Anika');
    expect(profile.xHandle).to.equal('@anika_fhe');
    expect(profile.avatarColor).to.equal('#1df8a4');
    expect(profile.version).to.equal(1n);
    expect(await matcher.memberCount()).to.equal(1n);
    expect(await matcher.members(0)).to.equal(alice.address);
  });

  it('computes a high compatibility score for matching encrypted chart factors', async () => {
    const matcher = await deployMatcher();
    const aliceChart = await encryptedChart(aliceClient, highMatch);
    const bobChart = await encryptedChart(bobClient, highMatch);

    await (await matcher.connect(alice).saveProfile('Anika', '@anika_fhe', '#1df8a4', aliceChart)).wait();
    await (await matcher.connect(bob).saveProfile('Riya', '@riyaverse', '#e8b84a', bobChart)).wait();
    await (await matcher.connect(alice).computeCompatibility(bob.address)).wait();
    await (await matcher.connect(alice).requestReveal(bob.address)).wait();
    await (await matcher.connect(bob).requestReveal(alice.address)).wait();

    const scoreHandle = await matcher.getScore(alice.address, bob.address);
    const score = await aliceClient.decryptForView(scoreHandle, FheTypes.Uint16).execute();

    expect(score).to.equal(85n);
  });

  it('stores computed scores under a symmetric pair key and authorizes both users', async () => {
    const matcher = await deployMatcher();
    const aliceChart = await encryptedChart(aliceClient, highMatch);
    const bobChart = await encryptedChart(bobClient, highMatch);

    await (await matcher.connect(alice).saveProfile('Anika', '@anika_fhe', '#1df8a4', aliceChart)).wait();
    await (await matcher.connect(bob).saveProfile('Riya', '@riyaverse', '#e8b84a', bobChart)).wait();
    await (await matcher.connect(alice).computeCompatibility(bob.address)).wait();
    await (await matcher.connect(alice).requestReveal(bob.address)).wait();
    await (await matcher.connect(bob).requestReveal(alice.address)).wait();

    const forwardHandle = await matcher.getScore(alice.address, bob.address);
    const reverseHandle = await matcher.getScore(bob.address, alice.address);
    const bobScore = await bobClient.decryptForView(reverseHandle, FheTypes.Uint16).execute();

    expect(reverseHandle).to.equal(forwardHandle);
    expect(bobScore).to.equal(85n);
  });

  it('keeps low compatibility below the reveal threshold', async () => {
    const matcher = await deployMatcher();
    const aliceChart = await encryptedChart(aliceClient, highMatch);
    const caraChart = await encryptedChart(caraClient, lowMatch);

    await (await matcher.connect(alice).saveProfile('Anika', '@anika_fhe', '#1df8a4', aliceChart)).wait();
    await (await matcher.connect(cara).saveProfile('Dev', '@devcrypted', '#38d5ff', caraChart)).wait();
    await (await matcher.connect(alice).computeCompatibility(cara.address)).wait();
    await (await matcher.connect(alice).requestReveal(cara.address)).wait();
    await (await matcher.connect(cara).requestReveal(alice.address)).wait();

    const scoreHandle = await matcher.getScore(alice.address, cara.address);
    const score = await aliceClient.decryptForView(scoreHandle, FheTypes.Uint16).execute();

    expect(score).to.be.lessThan(70n);
  });

  it('rejects invalid match requests before encrypted scoring runs', async () => {
    const matcher = await deployMatcher();
    const aliceChart = await encryptedChart(aliceClient, highMatch);

    await (await matcher.connect(alice).saveProfile('Anika', '@anika_fhe', '#1df8a4', aliceChart)).wait();

    await expect(matcher.connect(alice).computeCompatibility(alice.address)).to.be.revertedWith('SELF_MATCH');
    await expect(matcher.connect(bob).computeCompatibility(alice.address)).to.be.revertedWith('USER_A_CHART_MISSING');
    await expect(matcher.connect(alice).computeCompatibility(bob.address)).to.be.revertedWith('USER_B_CHART_MISSING');
  });

  it('masks public reveal results below the threshold and exposes high scores', async () => {
    const matcher = await deployMatcher();
    const aliceChart = await encryptedChart(aliceClient, highMatch);
    const bobChart = await encryptedChart(bobClient, highMatch);
    const caraChart = await encryptedChart(caraClient, lowMatch);

    await (await matcher.connect(alice).saveProfile('Anika', '@anika_fhe', '#1df8a4', aliceChart)).wait();
    await (await matcher.connect(bob).saveProfile('Riya', '@riyaverse', '#e8b84a', bobChart)).wait();
    await (await matcher.connect(cara).saveProfile('Dev', '@devcrypted', '#38d5ff', caraChart)).wait();
    await (await matcher.connect(alice).computeCompatibility(bob.address)).wait();
    await (await matcher.connect(alice).computeCompatibility(cara.address)).wait();
    await (await matcher.connect(alice).requestReveal(bob.address)).wait();
    await (await matcher.connect(bob).requestReveal(alice.address)).wait();
    await (await matcher.connect(alice).requestReveal(cara.address)).wait();
    await (await matcher.connect(cara).requestReveal(alice.address)).wait();
    await (await matcher.connect(alice).getPublicRevealScore(alice.address, bob.address)).wait();
    await (await matcher.connect(alice).getPublicRevealScore(alice.address, cara.address)).wait();

    const highRevealHandle = await matcher.getPublicRevealScore.staticCall(alice.address, bob.address);
    const lowRevealHandle = await matcher.getPublicRevealScore.staticCall(alice.address, cara.address);
    const highReveal = await aliceClient.decryptForView(highRevealHandle, FheTypes.Uint16).execute();
    const lowReveal = await aliceClient.decryptForView(lowRevealHandle, FheTypes.Uint16).execute();

    expect(highReveal).to.equal(85n);
    expect(lowReveal).to.equal(0n);
  });

  it('allows a matcher worker to compute pairs without revealing the score first', async () => {
    const matcher = await deployMatcher();
    const aliceChart = await encryptedChart(aliceClient, highMatch);
    const bobChart = await encryptedChart(bobClient, highMatch);

    await (await matcher.connect(alice).saveProfile('Anika', '@anika_fhe', '#1df8a4', aliceChart)).wait();
    await (await matcher.connect(bob).saveProfile('Riya', '@riyaverse', '#e8b84a', bobChart)).wait();
    await (await matcher.connect(cara).computeCompatibilityFor(alice.address, bob.address)).wait();

    const pair = await matcher.getPair(alice.address, bob.address);
    expect(pair.computed).to.equal(true);
    expect(pair.revealA).to.equal(false);
    expect(pair.revealB).to.equal(false);
    expect(await matcher.userPairCount(alice.address)).to.equal(1n);
    expect(await matcher.userPairCount(bob.address)).to.equal(1n);

    let decryptedBeforeReveal = true;
    try {
      await aliceClient.decryptForView(await matcher.getScore(alice.address, bob.address), FheTypes.Uint16).execute();
    } catch {
      decryptedBeforeReveal = false;
    }
    expect(decryptedBeforeReveal).to.equal(false);
  });

  it('requires both users to reveal before the score can decrypt and public reveal can expose it', async () => {
    const matcher = await deployMatcher();
    const aliceChart = await encryptedChart(aliceClient, highMatch);
    const bobChart = await encryptedChart(bobClient, highMatch);

    await (await matcher.connect(alice).saveProfile('Anika', '@anika_fhe', '#1df8a4', aliceChart)).wait();
    await (await matcher.connect(bob).saveProfile('Riya', '@riyaverse', '#e8b84a', bobChart)).wait();
    await (await matcher.connect(cara).computeCompatibilityFor(alice.address, bob.address)).wait();
    await (await matcher.connect(alice).requestReveal(bob.address)).wait();
    await (await matcher.connect(alice).getPublicRevealScore(alice.address, bob.address)).wait();

    const hiddenHandle = await matcher.getPublicRevealScore.staticCall(alice.address, bob.address);
    const hiddenReveal = await aliceClient.decryptForView(hiddenHandle, FheTypes.Uint16).execute();
    expect(hiddenReveal).to.equal(0n);

    await (await matcher.connect(bob).requestReveal(alice.address)).wait();
    expect(await matcher.bothRevealed(alice.address, bob.address)).to.equal(true);

    const scoreHandle = await matcher.getScore(alice.address, bob.address);
    const score = await aliceClient.decryptForView(scoreHandle, FheTypes.Uint16).execute();
    expect(score).to.equal(85n);
  });

  it('resets reveal consent when a pair is recomputed', async () => {
    const matcher = await deployMatcher();
    const aliceChart = await encryptedChart(aliceClient, highMatch);
    const bobChart = await encryptedChart(bobClient, highMatch);

    await (await matcher.connect(alice).saveProfile('Anika', '@anika_fhe', '#1df8a4', aliceChart)).wait();
    await (await matcher.connect(bob).saveProfile('Riya', '@riyaverse', '#e8b84a', bobChart)).wait();
    await (await matcher.connect(cara).computeCompatibilityFor(alice.address, bob.address)).wait();
    await (await matcher.connect(alice).requestReveal(bob.address)).wait();
    await (await matcher.connect(bob).requestReveal(alice.address)).wait();

    await (await matcher.connect(cara).computeCompatibilityFor(alice.address, bob.address)).wait();

    const pair = await matcher.getPair(alice.address, bob.address);
    expect(pair.computed).to.equal(true);
    expect(pair.revealA).to.equal(false);
    expect(pair.revealB).to.equal(false);
    const bobStoredVersion = pair.userA === bob.address ? pair.profileVersionA : pair.profileVersionB;
    expect(bobStoredVersion).to.equal(1n);
    expect(await matcher.userPairCount(alice.address)).to.equal(1n);
  });
});
