<!-- generated 2026-11-17T16:16:46.791Z · ch3.pdf · 2d7a39b5 -->

# ch3.pdf — study sheet
## 1. Chapter map
- Overview of The SQL Query Language, Data Definition, Basic Query Structure, Additional Basic Operations, Set Operations, Null Values, Aggregate Functions, Nested Subqueries, Modification of the Database [p. 1]
- History of SQL, including standards like SQL-86, SQL-89, and SQL-92 [p. 3]
- Data types such as varchar(n), int, smallint, numeric(p,d), real, double precision, and float(n) [p. 5]
- Relation definitions using CREATE TABLE syntax, including primary key and foreign key constraints [p. 7]
- Basic SQL query structure: select A1 , A2 , ..., A n from r1 , r2 , ..., r m where P [p. 10]

## 2. Core concepts
- The result of an SQL query is a relation [p. 10].
- Three values in logic are true, false, and unknown; any comparison with null returns unknown [p. 31].
- Aggregate functions operate on the multiset of values of a column of a relation to return values like avg, min, max, sum, or count [p. 33].
- A scalar subquery is one used where a single value is expected [p. 57].
- The Cartesian product (r1 x r2) generates every possible pair from tuples in r1 and r2 [p. 16].
- Correlated subqueries involve an inner query that depends on the outer query, such as using variable S in the outer query [p. 49].

## 3. Key terms to memorize
- **varchar(n)** — Variable length character strings with a user-specified maximum length n [p. 5].
- **numeric(p,d)** — Fixed point number with user-specified precision of p digits and d digits to the right of the decimal point [p. 5].
- **primary key** — A declaration on an attribute that automatically ensures not null [p. 7].
- **LIKE operator** — Used for string matching, employing percent (%) to match any substring and underscore (_) to match any character [p. 22].
- **GROUP BY clause** — Used with aggregate functions to group rows based on specified attributes (e.g., finding average salary per department) [p. 34].
- **WITH Clause** — Allows defining temporary named result sets, such as dept_total, for complex queries [p. 55].

## 4. Commands / syntax / formulas
- Basic Query Structure: select A1 , A2 , ..., A n from r1 , r2 , ..., r m where P [p. 10]
- Creating a table example: create table student ( ID varchar(5), name varchar(20) not null, dept_name varchar(20), tot_cred numeric(3,0), primary key (ID), foreign key (dept_name) references department); [p. 7]
- Selecting all attributes: select * from instructor [p. 14].
- String matching with LIKE: Find the names of all instructors whose name includes the substring “dar” using patterns like % and _ [p. 22].
- Ordering results: select distinct name from instructor order by name [p. 23].
- Deletion syntax: delete from instructor where dept_name= ’Finance’; [p. 59].

## 5. Likely exam questions
1. What is the difference between a primary key declaration and an attribute that is explicitly declared as NOT NULL?
2. How would you use the LIKE operator to find names containing "dar" in SQL?
3. Write a query structure using SELECT, FROM, and WHERE to retrieve specific attributes from relations.
4. Explain how aggregate functions like AVG and COUNT operate on relation data.
5. Describe the difference between using IN vs. NOT IN when checking set membership in subqueries.
6. How can you use a correlated subquery to find all supervisors (direct and indirect) of a specific person?

## 6. 60-second recap
- SQL queries follow the structure: select ... from ... where P [p. 10].
- Data types include varchar(n), int, numeric(p,d), etc., for defining relations [p. 5].
- Null values result in unknown when compared; aggregate functions handle nulls (count returns 0 if collection is only null) [p. 31, p. 38].
- Use GROUP BY with aggregates to calculate metrics per group, and HAVING to filter those groups [p. 34, p. 37].
- Subqueries can appear in the WHERE clause (using IN/NOT IN), FROM clause (derived tables), or SELECT clause (scalar subquery) [p. 28, p. 53, p. 57].
