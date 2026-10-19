import { pageAclFilter } from '../search/page-acl.ts';
import { sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';

/** Bind the reader once; both engines use exactly the same page ACL predicate. */
export function pageAclFragment(alias: string, subjects: string[]): SqlFragment {
  return sqlFragment`EXISTS (SELECT 1 FROM (SELECT ${subjects}::text[] AS subjects) acl_reader
    WHERE ${trustedSql(pageAclFilter(alias, 'acl_reader.subjects'))})`;
}
