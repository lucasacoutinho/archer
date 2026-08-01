export default {
  root: '../project',
  rules(archer) {
    archer.expect('src/application/**').not.toDependOn('src/infrastructure/**')
  },
}
