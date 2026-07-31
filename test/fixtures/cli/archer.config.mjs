export default {
  root: '../project',
  rules(archer) {
    archer.expect('src/domain/**').not.toDependOn('src/infrastructure/**')
  },
}
