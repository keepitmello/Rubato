export async function restoreMemberTaskEngine(compose, taskComponent, pi) {
  await compose([taskComponent])(pi);
}
