import hre from 'hardhat';

async function main() {
  const Factory = await hre.ethers.getContractFactory('HoroscopeMatcher');
  const matcher = await Factory.deploy();
  await matcher.waitForDeployment();

  console.log(`HoroscopeMatcher deployed to ${await matcher.getAddress()}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
